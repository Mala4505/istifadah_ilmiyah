/**
 * Fill entries.invoice_date + entries.sub_department_id for every entry, and
 * public.entry_bill_line (one row per bill) for entries that hold MORE THAN ONE
 * bill, from the Dept-module Excel export.
 *
 * Needs the "multiple budget" export (sheet "All Budget Entries"), which has a
 * UBBL Number on every bill line. The "consolidated long" export has no UBBL
 * numbers, so bills cannot be tied to an entry -- this script refuses it.
 *
 * Dry run is the default and writes nothing:
 *
 *   node --env-file=.env scripts/import-bill-lines.mjs "C:\path\to\tenant_multiple_budget_6_....xlsx"
 *
 * Apply for real (one transaction; all or nothing):
 *
 *   node --env-file=.env scripts/import-bill-lines.mjs "C:\path\to\file.xlsx" --commit
 *
 * Safe to re-run. entries.amount is never touched -- the scrape owns it -- and an
 * existing sub_department_id is never overwritten. An EMPTY sub_department_id is only
 * filled for REIMBURSEMENTS (nobody has classified those and the portal list has no
 * head); invoices keep the sub-department a reviewer chose in the review screen.
 * Needs DATABASE_URL in .env (same as the app's importers).
 */
import * as XLSX from 'xlsx'
import pg from 'pg'
import * as fs from 'node:fs'

const file = process.argv[2]
const commit = process.argv.includes('--commit')
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node --env-file=.env scripts/import-bill-lines.mjs <export.xlsx> [--commit]')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing. Run with --env-file=.env from the repo root.')
  process.exit(1)
}

// Same rule as lib/normalize.ts normalizeId (number -> integer string, string -> trimmed).
function normalizeId(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : null
  if (typeof value === 'string') return value.trim() || null
  return null
}
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function orNull(value) {
  const s = String(value ?? '').replace(/[   ]/g, ' ').trim()
  if (s === '' || /^-+$/.test(s) || ['NA', 'N/A', 'NULL'].includes(s.toUpperCase())) return null
  return s
}
function toIsoDate(value) {
  const s = orNull(value)
  const m = s?.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (!m) return null
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}
function toAmount(value) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, ''))
  return Number.isFinite(n) ? n : null
}

// ---- read the sheet: budget-head rows carry the head, bill rows follow ------
const wb = XLSX.read(fs.readFileSync(file))
const sheet = wb.Sheets['All Budget Entries'] ?? wb.Sheets[wb.SheetNames[0]]
const rows = XLSX.utils.sheet_to_json(sheet, { raw: true, defval: null })
if (rows.length === 0 || !('UBBL Number' in rows[0])) {
  console.error('This file has no "UBBL Number" column (the "consolidated long" export?). Use the "multiple budget" export instead.')
  process.exit(1)
}

const groups = new Map() // ubbl -> [{...bill}]
let head = null
let dept = null
let skippedNoUbbl = 0
for (const r of rows) {
  if (r['Budget Head']) {
    head = String(r['Budget Head'])
    dept = String(r['Department'] ?? '')
  }
  const hasBill = r['Invoice Amount'] !== null || r['Vendor Name'] !== null || r['UBBL Number'] !== null
  if (!hasBill) continue
  const ubbl = normalizeId(r['UBBL Number'])
  if (!ubbl) {
    // The export's grand-total row (amount only, no vendor, no UBBL) lands here too.
    if (r['Vendor Name'] !== null) skippedNoUbbl++
    continue
  }
  if (!groups.has(ubbl)) groups.set(ubbl, [])
  groups.get(ubbl).push({
    invoice_number: orNull(r['Invoice Number']),
    invoice_date: toIsoDate(r['Invoice Date']),
    vendor_raw: orNull(r['Vendor Name']),
    amount: toAmount(r['Invoice Amount']),
    budget_head_raw: head,
    department: dept,
  })
}

// ---- resolve against the DB --------------------------------------------------
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const entries = new Map(
    (await client.query('select id, ubbl_number, type, amount, sub_department_id from public.entries where ubbl_number = any($1::text[])', [[...groups.keys()]])).rows.map(
      (e) => [e.ubbl_number, e]
    )
  )
  const subs = (
    await client.query(
      `select sd.id, sd.name, d.name as dept from public.sub_department sd join public.department d on d.id = sd.department_id`
    )
  ).rows.map((s) => ({ id: s.id, dept: norm(s.dept), name: norm(s.name), label: `${s.dept} / ${s.name}` }))
  const subLabel = (id) => subs.find((s) => s.id === id)?.label ?? `#${id}`

  // The head label is "<department-ish> (<sub-department>)", and department
  // names can contain brackets themselves ("HR (B) / KG Khidmat Takhmeen"), so
  // match by suffix instead of splitting on a bracket. Longest name wins.
  function resolveSub(headRaw, deptName) {
    const label = norm(headRaw)
    const d = norm(deptName)
    let best = null
    for (const s of subs) {
      if (s.dept !== d) continue
      if (label.endsWith(s.name) && (!best || s.name.length > best.name.length)) best = s
    }
    return best?.id ?? null
  }

  // Only UBBLs with MORE THAN ONE bill get rows in entry_bill_line -- a
  // single-bill entry already holds its vendor, invoice number and amount on
  // `entries`, and a second copy of the amount would drift the first time the
  // scrape updates the entry. A single-bill entry just gets its invoice date and
  // (if it has none yet) its sub-department written onto `entries` itself.
  const plan = []
  const notFound = []
  let noSub = 0
  const amountMismatch = []
  const subConflicts = []
  const unresolvedHeads = new Map() // head label -> { dept, lines, amount }
  const multiHeadReimb = []
  for (const [ubbl, bills] of groups) {
    const entry = entries.get(ubbl)
    if (!entry) {
      notFound.push({ ubbl, vendor: bills[0].vendor_raw, amount: bills.reduce((t, b) => t + (b.amount ?? 0), 0), dept: bills[0].department, head: bills[0].budget_head_raw })
      continue
    }
    const lines = bills.map((b, i) => {
      const sub = resolveSub(b.budget_head_raw, b.department)
      if (sub === null) {
        noSub++
        const u = unresolvedHeads.get(b.budget_head_raw) ?? { dept: b.department, lines: 0, amount: 0 }
        u.lines++
        u.amount += b.amount ?? 0
        unresolvedHeads.set(b.budget_head_raw, u)
      }
      return { ...b, line_no: i + 1, sub_department_id: sub }
    })
    const billSum = lines.reduce((t, l) => t + (l.amount ?? 0), 0)
    if (Math.abs(billSum - Number(entry.amount ?? 0)) > 1.01) amountMismatch.push({ ubbl, entry: Number(entry.amount), bills: billSum })
    const dates = lines.map((l) => l.invoice_date).filter(Boolean).sort()
    const lineSubs = new Set(lines.map((l) => l.sub_department_id))
    // Entry-level sub-department: only when every bill agrees on one.
    const entrySub = lineSubs.size === 1 ? [...lineSubs][0] : null
    if (entrySub !== null && entry.sub_department_id !== null && entry.sub_department_id !== entrySub) {
      subConflicts.push({ ubbl, type: entry.type, vendor: lines[0].vendor_raw, amount: Number(entry.amount), db: entry.sub_department_id, file: entrySub, head: lines[0].budget_head_raw })
    }
    if (entry.type === 'reimbursement' && entrySub === null && entry.sub_department_id === null) {
      multiHeadReimb.push({ ubbl, vendor: lines[0].vendor_raw, amount: Number(entry.amount), heads: [...new Set(lines.map((l) => l.budget_head_raw))] })
    }
    plan.push({
      entryId: entry.id,
      multi: lines.length > 1,
      lines,
      invoiceDate: dates[0] ?? null,
      entrySub,
      fillsSub: entry.type === 'reimbursement' && entrySub !== null && entry.sub_department_id === null,
      type: entry.type,
      ubbl,
    })
  }

  const multi = plan.filter((p) => p.multi)
  const lineCount = multi.reduce((t, p) => t + p.lines.length, 0)
  console.log(`File: ${groups.size} UBBLs, ${[...groups.values()].reduce((t, g) => t + g.length, 0)} bill lines`)
  console.log(`Matched to an entry: ${plan.length} UBBLs`)
  console.log(`  single-bill entries: ${plan.length - multi.length} (only invoice date + sub-department go onto entries)`)
  console.log(`  multi-bill entries : ${multi.length} (${lineCount} rows go into entry_bill_line)`)
  console.log(`Entries that would get a sub-department they don't have yet: ${plan.filter((p) => p.fillsSub).length} (reimbursements only)`)
  const rupees = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })
  const reimbConflicts = subConflicts.filter((c) => c.type === 'reimbursement')
  console.log(`Entries whose existing sub-department differs from the file's (left unchanged): ${subConflicts.length} (${reimbConflicts.length} are reimbursements)`)
  console.log(`UBBL not in our DB (skipped): ${notFound.length}`)
  console.log(`Bill lines whose head did not resolve to a sub-department: ${noSub}`)
  console.log(`Lines without a UBBL (skipped): ${skippedNoUbbl}`)
  console.log(`Entries where bill total differs from entries.amount by more than Rs 1: ${amountMismatch.length}`)

  console.log('\n== EXCEPTIONS (nothing below is changed by this script) ==')
  console.log('\n[1] In the export but not in our DB (need a fresh scrape):')
  for (const n of notFound) console.log(`   ${n.ubbl} | ${n.dept} | ${n.vendor} | Rs ${rupees(n.amount)} | ${n.head}`)
  console.log('\n[2] Head in the export has no matching sub-department (add the sub-department, then re-run):')
  for (const [head, u] of unresolvedHeads) console.log(`   ${head} | dept ${u.dept} | ${u.lines} bill lines | Rs ${rupees(u.amount)}`)
  console.log('\n[3] Reimbursements whose existing sub-department contradicts the export (kept as is):')
  for (const c of reimbConflicts) console.log(`   ${c.ubbl} | ${c.vendor} | Rs ${rupees(c.amount)} | export head: ${c.head} -> ${subLabel(c.file)} | in DB: ${subLabel(c.db)}`)
  console.log('\n[4] Reimbursements split over several sub-departments (no single sub-department set; per-bill rows hold the split):')
  for (const m of multiHeadReimb) console.log(`   ${m.ubbl} | ${m.vendor} | Rs ${rupees(m.amount)} | ${m.heads.join(' ; ')}`)
  console.log('\n[5] Bill total differs from the entry amount:')
  for (const m of amountMismatch) console.log(`   ${m.ubbl}: entry Rs ${rupees(m.entry)} vs bills Rs ${rupees(m.bills)}`)
  console.log(`\n(Also: ${subConflicts.length - reimbConflicts.length} non-reimbursement entries where a reviewer's sub-department differs from the export's head -- left alone by design.)`)

  if (!commit) {
    console.log('\nDRY RUN -- nothing written. Add --commit to apply.')
  } else {
    await client.query('begin')
    for (const p of plan) {
      // Clear any lines from an earlier run, so a UBBL that is now single-bill keeps none.
      await client.query('delete from public.entry_bill_line where entry_id = $1', [p.entryId])
      if (p.multi) {
        for (const l of p.lines) {
          await client.query(
            `insert into public.entry_bill_line
               (entry_id, line_no, invoice_number, invoice_date, vendor_raw, amount, budget_head_raw, sub_department_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [p.entryId, l.line_no, l.invoice_number, l.invoice_date, l.vendor_raw, l.amount, l.budget_head_raw, l.sub_department_id]
          )
        }
      }
      // sub_department_id is only ever filled in, never overwritten.
      await client.query(
        'update public.entries set invoice_date = $2, sub_department_id = coalesce(sub_department_id, $3) where id = $1',
        [p.entryId, p.invoiceDate, p.fillsSub ? p.entrySub : null]
      )
    }
    await client.query('commit')
    console.log(`\nCOMMITTED: ${plan.length} entries updated, ${lineCount} bill rows written for ${multi.length} multi-bill entries.`)
  }
} catch (err) {
  await client.query('rollback').catch(() => {})
  console.error('Failed, nothing was written:', err.message)
  process.exitCode = 1
} finally {
  await client.end()
}
