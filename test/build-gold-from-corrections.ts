/**
 * test/build-gold-from-corrections.ts
 *
 * Builds test/gold.json from real data instead of hand-typed JSON (decided
 * 2026-08-12, MASTER-PLAN §17.22 / §18 Phase 1B "Mine"): the 21 invoices go
 * through the normal upload + review-queue correction flow, and this script
 * assembles gold.json from what that flow already recorded. No in-app
 * labeling screen was built — that was explicitly decided against.
 *
 * Anti-anchoring (§9.1, §9.3 item 1): a reviewer shown a pre-filled OCR
 * value tends to accept it even when subtly wrong, which would let the gold
 * set inherit the correction log's own optimism bias. To keep ~10 of the 21
 * genuinely blind, this script layers two sources, blind notes taking
 * priority per document:
 *
 *   1. test/gold-blind-notes.json (optional, you write this BEFORE
 *      uploading — see test/gold-blind-notes.example.json for the shape).
 *      Entries here are used as-is; they never came from OCR output, so
 *      there's nothing to anchor on.
 *   2. Everything else: the live document_extraction/_line_item `_verified`
 *      columns, i.e. whatever a reviewer confirmed or corrected through the
 *      normal review queue (components/entries/detail's review screen ->
 *      private.verify_document_extraction, 20260813000002_verify_document_extraction.sql).
 *
 * Run with: npx tsx --conditions=react-server test/build-gold-from-corrections.ts
 * (also wired as `npm run gold:build`).
 *
 * Safe to re-run any time corrections change — it's a pure read + overwrite
 * of test/gold.json, no database writes.
 */
import path from 'node:path'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

interface GoldLineItem {
  description: string
  amount: number
}

interface GoldEntry {
  source_file: string
  labeled: boolean
  vendor_name: string | null
  invoice_number: string | null
  invoice_date: string | null
  subtotal: number | null
  tax_amount: number | null
  total_amount: number | null
  line_items: GoldLineItem[]
  is_gujarati_or_devanagari: boolean
  notes: string
}

/** Partial on purpose -- a blind-notes entry only needs the fields the
 * labeler actually read off the PDF; source_file is the only required key. */
type BlindNoteEntry = Partial<Omit<GoldEntry, 'source_file' | 'labeled'>> & {
  source_file: string
}

const EMPTY_GOLD_ENTRY: Omit<GoldEntry, 'source_file'> = {
  labeled: false,
  vendor_name: null,
  invoice_number: null,
  invoice_date: null,
  subtotal: null,
  tax_amount: null,
  total_amount: null,
  line_items: [],
  is_gujarati_or_devanagari: false,
  notes: '',
}

function loadBlindNotes(): Map<string, BlindNoteEntry> {
  const notesPath = path.resolve(process.cwd(), 'test', 'gold-blind-notes.json')
  const map = new Map<string, BlindNoteEntry>()
  if (!existsSync(notesPath)) {
    console.log(
      'No test/gold-blind-notes.json found -- every entry will be sourced from review-queue ' +
        'corrections. See test/gold-blind-notes.example.json for the anti-anchoring flow (§9.1).'
    )
    return map
  }
  const entries = JSON.parse(readFileSync(notesPath, 'utf8')) as BlindNoteEntry[]
  for (const entry of entries) {
    map.set(entry.source_file, entry)
  }
  console.log(`Loaded ${map.size} blind-note entr${map.size === 1 ? 'y' : 'ies'} from test/gold-blind-notes.json.`)
  return map
}

async function main() {
  process.loadEnvFile(path.resolve(process.cwd(), '.env'))
  const { Pool, types } = await import('pg')
  const { serverEnv } = await import('@/lib/env.server')

  // Same fix as lib/import/run-import.ts: hand back `date` as the raw
  // "YYYY-MM-DD" string Postgres sends, so no server-timezone shift can
  // move invoice_date across a calendar day.
  types.setTypeParser(1082 /* date */, (value: string) => value)

  const pool = new Pool({ connectionString: serverEnv.DATABASE_URL })
  const blindNotes = loadBlindNotes()

  const { rows: docs } = await pool.query<{
    original_filename: string
    verified_at: string | null
    vendor_name_verified: string | null
    invoice_number_verified: string | null
    invoice_date_verified: string | null
    subtotal_verified: string | null
    tax_amount_verified: string | null
    total_amount_verified: string | null
    notes_verified: string | null
    document_extraction_id: number | null
    contains_non_latin_script: boolean | null
  }>(`
    select
      sd.original_filename,
      de.verified_at,
      de.vendor_name_verified,
      de.invoice_number_verified,
      de.invoice_date_verified,
      de.subtotal_verified,
      de.tax_amount_verified,
      de.total_amount_verified,
      de.notes_verified,
      de.id as document_extraction_id,
      run.contains_non_latin_script
    from public.source_document sd
    left join public.document_extraction de on de.source_document_id = sd.id
    left join public.ocr_extraction_run run on run.id = de.current_extraction_run_id
    order by sd.original_filename
  `)

  const { rows: lineItemRows } = await pool.query<{
    document_extraction_id: number
    description_verified: string | null
    line_amount_verified: string | null
  }>(`
    select document_extraction_id, description_verified, line_amount_verified
    from public.document_extraction_line_item
    where document_extraction_id = any($1::bigint[])
    order by document_extraction_id, line_order
  `, [docs.map((d) => d.document_extraction_id).filter((id): id is number => id !== null)])

  const lineItemsByExtractionId = new Map<number, GoldLineItem[]>()
  for (const li of lineItemRows) {
    const list = lineItemsByExtractionId.get(li.document_extraction_id) ?? []
    if (li.description_verified !== null && li.line_amount_verified !== null) {
      list.push({ description: li.description_verified, amount: Number(li.line_amount_verified) })
    }
    lineItemsByExtractionId.set(li.document_extraction_id, list)
  }

  // The authoritative list of the 21 is Invoices/*.pdf, NOT whatever happens
  // to be uploaded yet -- a document not uploaded (or not yet corrected)
  // still needs its skeleton entry so gold.json stays a fixed 21-entry file
  // (score.ts's "N/21 labeled" framing depends on that), and so a blind
  // note written before upload has something to land on.
  const invoicesDir = path.resolve(process.cwd(), 'Invoices')
  const invoiceFilenames = existsSync(invoicesDir)
    ? readdirSync(invoicesDir).filter((f) => f.toLowerCase().endsWith('.pdf'))
    : []
  if (invoiceFilenames.length === 0) {
    console.warn('Warning: no Invoices/*.pdf found -- falling back to whatever source_document rows exist in the DB.')
  }

  const docsByFilename = new Map(docs.map((d) => [d.original_filename, d]))
  const baseFilenames = new Set<string>(
    invoiceFilenames.length > 0 ? invoiceFilenames : docs.map((d) => d.original_filename)
  )
  // A blind note for a filename that matches neither Invoices/ nor any
  // upload is very likely a typo -- surface it instead of silently dropping it.
  for (const sourceFile of blindNotes.keys()) {
    if (!baseFilenames.has(sourceFile)) {
      console.warn(`Warning: gold-blind-notes.json has "${sourceFile}", which matches no file in Invoices/. Typo?`)
      baseFilenames.add(sourceFile)
    }
  }

  const goldEntries: GoldEntry[] = []
  let fromBlindNotes = 0
  let fromCorrections = 0
  let unverified = 0

  for (const sourceFile of baseFilenames) {
    const blind = blindNotes.get(sourceFile)
    if (blind) {
      fromBlindNotes++
      goldEntries.push({
        source_file: sourceFile,
        labeled: true,
        vendor_name: blind.vendor_name ?? null,
        invoice_number: blind.invoice_number ?? null,
        invoice_date: blind.invoice_date ?? null,
        subtotal: blind.subtotal ?? null,
        tax_amount: blind.tax_amount ?? null,
        total_amount: blind.total_amount ?? null,
        line_items: blind.line_items ?? [],
        is_gujarati_or_devanagari: blind.is_gujarati_or_devanagari ?? false,
        notes: blind.notes ?? '(from blind pre-notes)',
      })
      continue
    }

    const doc = docsByFilename.get(sourceFile)
    if (!doc || doc.verified_at === null || doc.document_extraction_id === null) {
      unverified++
      goldEntries.push({ source_file: sourceFile, ...EMPTY_GOLD_ENTRY })
      continue
    }

    fromCorrections++
    goldEntries.push({
      source_file: sourceFile,
      labeled: true,
      vendor_name: doc.vendor_name_verified,
      invoice_number: doc.invoice_number_verified,
      invoice_date: doc.invoice_date_verified,
      subtotal: doc.subtotal_verified === null ? null : Number(doc.subtotal_verified),
      tax_amount: doc.tax_amount_verified === null ? null : Number(doc.tax_amount_verified),
      total_amount: doc.total_amount_verified === null ? null : Number(doc.total_amount_verified),
      line_items: lineItemsByExtractionId.get(doc.document_extraction_id) ?? [],
      is_gujarati_or_devanagari: doc.contains_non_latin_script ?? false,
      notes: doc.notes_verified ?? '',
    })
  }

  goldEntries.sort((a, b) => a.source_file.localeCompare(b.source_file))

  const goldPath = path.resolve(process.cwd(), 'test', 'gold.json')
  writeFileSync(goldPath, JSON.stringify(goldEntries, null, 2) + '\n')

  const labeledCount = goldEntries.filter((e) => e.labeled).length
  console.log(
    `\nWrote test/gold.json: ${goldEntries.length} entries, ${labeledCount} labeled ` +
      `(${fromBlindNotes} from blind notes, ${fromCorrections} from review-queue corrections, ` +
      `${unverified} not yet verified/uploaded).`
  )
  if (labeledCount < goldEntries.length) {
    console.log(
      `${goldEntries.length - labeledCount} of the ${goldEntries.length} expected invoices are not yet labeled -- run npm run score to see which.`
    )
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
