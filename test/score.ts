/**
 * test/score.ts
 *
 * The accuracy harness described in MASTER-PLAN §9.1 — run via `npm run
 * score` (wired in package.json to `tsx test/score.ts`).
 *
 * Loads test/gold.json, skips any entry with `labeled: false` (printing a
 * clear message), runs extraction on the rest, and prints a per-field
 * table against the exact bars in §9.1:
 *
 *   total_amount exact match            >= 98% (20/21)
 *   invoice_number exact match (trim)   >= 90%
 *   vendor_name fuzzy match >= 0.9      >= 90%
 *   line-item count exact               >= 90%
 *   line amount exact, on matched lines >= 95%
 *   non-financial pages classified false = 100%
 *   Gujarati document escalates to Sonnet = 100%
 *
 * There is no real extraction pipeline wired yet — that depends on the
 * Anthropic key and lib/claude-client.ts / lib/jobs/handlers/extract.ts,
 * owned by other agents and not necessarily written yet. `runExtraction`
 * below is a clearly-marked stub that throws until Phase 1A day 2. The
 * scoring/comparison/reporting logic is real and ready to flip on the
 * moment `runExtraction` is wired to the actual pipeline — nothing else in
 * this file should need to change.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GoldLineItem {
  description: string
  amount: number
}

/** Optional page-level ground truth. Not part of the day-1 gold.json
 * skeleton (§9.1's shape has no `pages` field), but score.ts supports it
 * so the "non-financial pages classified false" bar becomes checkable the
 * moment someone adds it to an entry, without a schema migration. */
interface GoldPage {
  page_number: number
  is_financial_document: boolean
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
  pages?: GoldPage[]
}

interface ExtractionLineItem {
  description: string
  amount: number
}

interface ExtractionPage {
  page_number: number
  is_financial_document: boolean
}

/** Shape the real pipeline (lib/claude-client.ts + lib/jobs/handlers/extract.ts)
 * is expected to return per document, per MASTER-PLAN §8's tool schema. */
interface ExtractionResult {
  vendor_name: string | null
  invoice_number: string | null
  invoice_date: string | null
  subtotal: number | null
  tax_amount: number | null
  total_amount: number | null
  line_items: ExtractionLineItem[]
  pages: ExtractionPage[]
  /** Which model actually produced this result — 'sonnet' when Gujarati/
   * Devanagari or low confidence triggered escalation, 'haiku' otherwise. */
  model_used: 'haiku' | 'sonnet'
}

// ---------------------------------------------------------------------------
// The stub — replace the body once the real pipeline exists.
// ---------------------------------------------------------------------------

/**
 * STUB. Not wired yet — Phase 1A day 2.
 *
 * Once lib/claude-client.ts and lib/jobs/handlers/extract.ts exist, this
 * should call the same extraction path production uses (load the PDF,
 * rasterize, call Claude with extraction-schema.ts's tool schema, return
 * the parsed result) so the harness measures the real pipeline, not a
 * simulation of it.
 */
async function runExtraction(pdfPath: string): Promise<ExtractionResult> {
  void pdfPath
  throw new Error('OCR pipeline not wired yet — Phase 1A day 2')
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Cents-precise equality for money fields, avoiding float noise. */
function moneyEquals(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.round(a * 100) === Math.round(b * 100)
}

function trimmedEquals(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return a.trim() === b.trim()
}

/** Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  const prevRow = new Array<number>(n + 1)
  const currRow = new Array<number>(n + 1)
  for (let j = 0; j <= n; j++) prevRow[j] = j

  for (let i = 1; i <= m; i++) {
    currRow[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const del = (prevRow[j] ?? 0) + 1
      const ins = (currRow[j - 1] ?? 0) + 1
      const sub = (prevRow[j - 1] ?? 0) + cost
      currRow[j] = Math.min(del, ins, sub)
    }
    for (let j = 0; j <= n; j++) prevRow[j] = currRow[j] ?? 0
  }
  return prevRow[n] ?? Math.max(m, n)
}

/** Normalized similarity in [0, 1]; 1 = identical. Case/whitespace-insensitive. */
function fuzzySimilarity(a: string, b: string): number {
  const na = a.trim().toLowerCase()
  const nb = b.trim().toLowerCase()
  if (na === nb) return 1
  const maxLen = Math.max(na.length, nb.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(na, nb) / maxLen
}

/** Greedily pairs gold line items with extracted line items by description
 * similarity, so amounts can be compared "on matched lines" per §9.1. */
function matchLineItems(
  gold: GoldLineItem[],
  extracted: ExtractionLineItem[]
): Array<{ gold: GoldLineItem; extracted: ExtractionLineItem }> {
  const remaining = [...extracted]
  const pairs: Array<{ gold: GoldLineItem; extracted: ExtractionLineItem }> = []

  for (const g of gold) {
    let bestIdx = -1
    let bestScore = -1
    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]
      if (!candidate) continue
      const score = fuzzySimilarity(g.description, candidate.description)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }
    // Require some minimal resemblance before calling it a match at all;
    // otherwise every gold line would "match" the nearest leftover even
    // when the extraction dropped it entirely.
    if (bestIdx >= 0 && bestScore >= 0.4) {
      const matched = remaining[bestIdx]
      if (matched) {
        pairs.push({ gold: g, extracted: matched })
        remaining.splice(bestIdx, 1)
      }
    }
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface MetricRow {
  metric: string
  bar: string
  passCount: number
  sampleSize: number
  pct: number | null // null = not applicable (no ground truth available)
  passed: boolean | null
}

function pct(passCount: number, sampleSize: number): number | null {
  if (sampleSize === 0) return null
  return (passCount / sampleSize) * 100
}

function formatPct(p: number | null): string {
  if (p === null) return 'N/A'
  return `${p.toFixed(1)}%`
}

function formatRow(row: MetricRow): string {
  const status = row.passed === null ? '—' : row.passed ? 'PASS' : 'FAIL'
  return [
    row.metric.padEnd(38),
    row.bar.padEnd(14),
    `${formatPct(row.pct)} (${row.passCount}/${row.sampleSize})`.padEnd(18),
    status,
  ].join(' ')
}

async function main(): Promise<void> {
  const goldPath = path.resolve(process.cwd(), 'test', 'gold.json')
  const raw = readFileSync(goldPath, 'utf8')
  const allEntries = JSON.parse(raw) as GoldEntry[]

  const labeled = allEntries.filter((e) => e.labeled)
  const unlabeled = allEntries.filter((e) => !e.labeled)

  console.log(`Gold set: ${allEntries.length} entries (${labeled.length} labeled, ${unlabeled.length} unlabeled)\n`)

  if (unlabeled.length > 0) {
    console.log(
      `Skipping ${unlabeled.length} unlabeled entr${unlabeled.length === 1 ? 'y' : 'ies'} (labeled: false):`
    )
    for (const e of unlabeled) {
      console.log(`  - ${e.source_file}`)
    }
    console.log('')
  }

  if (labeled.length === 0) {
    console.log('0/21 labeled, run this after completing test/gold.json')
    console.log('See test/gold.README.md for labeling instructions (MASTER-PLAN §9.1, §11 item 1).')
    return
  }

  // Per-entry results, collected before aggregation so one bad/erroring
  // entry doesn't take down the whole run.
  const invoicesDir = path.resolve(process.cwd(), 'Invoices')

  let totalAmountPass = 0
  let invoiceNumberPass = 0
  let vendorNamePass = 0
  let lineCountPass = 0
  let lineAmountMatchedTotal = 0
  let lineAmountMatchedPass = 0
  let gujaratiTotal = 0
  let gujaratiPass = 0
  let pageClassificationTotal = 0
  let pageClassificationPass = 0

  let extractionFailures = 0
  let pipelineNotWired = false

  for (const entry of labeled) {
    const pdfPath = path.join(invoicesDir, entry.source_file)
    let result: ExtractionResult
    try {
      result = await runExtraction(pdfPath)
    } catch (err) {
      extractionFailures++
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('not wired yet')) {
        pipelineNotWired = true
      } else {
        console.error(`  extraction failed for ${entry.source_file}: ${message}`)
      }
      continue
    }

    if (moneyEquals(entry.total_amount, result.total_amount)) totalAmountPass++
    if (trimmedEquals(entry.invoice_number, result.invoice_number)) invoiceNumberPass++
    if (
      entry.vendor_name !== null &&
      result.vendor_name !== null &&
      fuzzySimilarity(entry.vendor_name, result.vendor_name) >= 0.9
    ) {
      vendorNamePass++
    } else if (entry.vendor_name === null && result.vendor_name === null) {
      vendorNamePass++
    }

    if (entry.line_items.length === result.line_items.length) lineCountPass++

    const matched = matchLineItems(entry.line_items, result.line_items)
    for (const { gold, extracted } of matched) {
      lineAmountMatchedTotal++
      if (moneyEquals(gold.amount, extracted.amount)) lineAmountMatchedPass++
    }

    if (entry.is_gujarati_or_devanagari) {
      gujaratiTotal++
      if (result.model_used === 'sonnet') gujaratiPass++
    }

    if (entry.pages && entry.pages.length > 0) {
      const byPageNumber = new Map(result.pages.map((p) => [p.page_number, p]))
      for (const goldPage of entry.pages) {
        if (goldPage.is_financial_document) continue // only scoring the "classified false" bar
        pageClassificationTotal++
        const extractedPage = byPageNumber.get(goldPage.page_number)
        if (extractedPage && extractedPage.is_financial_document === false) {
          pageClassificationPass++
        }
      }
    }
  }

  if (pipelineNotWired) {
    console.log(
      `Extraction pipeline is not wired yet (${extractionFailures}/${labeled.length} labeled entries could not be run).`
    )
    console.log('This is expected before Phase 1A day 2. Scoring logic below is ready; nothing to report yet.\n')
    return
  }

  const scored = labeled.length - extractionFailures
  if (scored === 0) {
    console.log('All labeled entries failed extraction — nothing to score.')
    return
  }

  const rows: MetricRow[] = [
    {
      metric: 'total_amount exact match',
      bar: '>= 98%',
      passCount: totalAmountPass,
      sampleSize: scored,
      pct: pct(totalAmountPass, scored),
      passed: (pct(totalAmountPass, scored) ?? 0) >= 98,
    },
    {
      metric: 'invoice_number exact match (trim)',
      bar: '>= 90%',
      passCount: invoiceNumberPass,
      sampleSize: scored,
      pct: pct(invoiceNumberPass, scored),
      passed: (pct(invoiceNumberPass, scored) ?? 0) >= 90,
    },
    {
      metric: 'vendor_name fuzzy match >= 0.9',
      bar: '>= 90%',
      passCount: vendorNamePass,
      sampleSize: scored,
      pct: pct(vendorNamePass, scored),
      passed: (pct(vendorNamePass, scored) ?? 0) >= 90,
    },
    {
      metric: 'line-item count exact',
      bar: '>= 90%',
      passCount: lineCountPass,
      sampleSize: scored,
      pct: pct(lineCountPass, scored),
      passed: (pct(lineCountPass, scored) ?? 0) >= 90,
    },
    {
      metric: 'line amount exact (matched lines)',
      bar: '>= 95%',
      passCount: lineAmountMatchedPass,
      sampleSize: lineAmountMatchedTotal,
      pct: pct(lineAmountMatchedPass, lineAmountMatchedTotal),
      passed:
        lineAmountMatchedTotal === 0 ? null : (pct(lineAmountMatchedPass, lineAmountMatchedTotal) ?? 0) >= 95,
    },
    {
      metric: 'non-financial pages classified false',
      bar: '= 100%',
      passCount: pageClassificationPass,
      sampleSize: pageClassificationTotal,
      pct: pct(pageClassificationPass, pageClassificationTotal),
      passed:
        pageClassificationTotal === 0
          ? null
          : (pct(pageClassificationPass, pageClassificationTotal) ?? 0) === 100,
    },
    {
      metric: 'Gujarati document escalates to Sonnet',
      bar: '= 100%',
      passCount: gujaratiPass,
      sampleSize: gujaratiTotal,
      pct: pct(gujaratiPass, gujaratiTotal),
      passed: gujaratiTotal === 0 ? null : (pct(gujaratiPass, gujaratiTotal) ?? 0) === 100,
    },
  ]

  console.log(`Scored ${scored}/${labeled.length} labeled entries (${extractionFailures} extraction failures)\n`)
  console.log(['Metric'.padEnd(38), 'Bar'.padEnd(14), 'Result'.padEnd(18), 'Status'].join(' '))
  console.log('-'.repeat(38 + 14 + 18 + 6))
  for (const row of rows) {
    console.log(formatRow(row))
  }
  console.log('')

  if (pageClassificationTotal === 0) {
    console.log(
      'Note: "non-financial pages classified false" is N/A — gold.json entries have no `pages` ground truth yet (optional field, not part of the day-1 skeleton).'
    )
  }
  if (gujaratiTotal === 0) {
    console.log('Note: "Gujarati document escalates to Sonnet" is N/A — no labeled entry has is_gujarati_or_devanagari: true.')
  }

  const applicable = rows.filter((r) => r.passed !== null)
  const allPass = applicable.every((r) => r.passed)
  console.log(`\n${allPass ? 'All applicable bars met.' : 'Some bars missed — tune the prompt and re-score.'}`)

  if (!allPass) {
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('score.ts crashed:', err)
  process.exit(1)
})
