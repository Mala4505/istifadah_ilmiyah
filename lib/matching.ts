/**
 * Document-to-entry matching (MASTER-PLAN §5 row 6, §11.2 Day 3): "suggested
 * matches on vendor + amount + date proximity," plus invoice number
 * (redesign plan §9) where both sides have one, plus a learned vendor_alias
 * short-circuit for the vendor sub-score itself (redesign plan §10).
 *
 * Deliberately computed on read, not persisted — the task brief for this
 * screen is explicit that there is no requirement to store a suggestion,
 * only to show one. Scoring an in-memory candidate list is cheap at this
 * volume (1,000–10,000 entries, §0) and means a suggestion is never stale:
 * every page load recomputes against the current state of `entries` and
 * `document_extraction`.
 *
 * Vendor similarity uses a bigram Dice coefficient over `normalizeVendorName`
 * output rather than the database's `pg_trgm` index/`similarity()` function.
 * Both are reasonable per the task brief ("and/or"); bigram-Dice in process
 * was chosen because the candidate pool here is already narrowed by the
 * amount/date pre-filter the caller applies before scoring (see
 * app/(app)/documents/page.tsx), so there is no separate trigram-indexed
 * query to write, and normalizeVendorName already guarantees both sides are
 * compared on the same stripped/lowercased key.
 */

import { normalizeVendorName } from '@/lib/normalize'

/** A document's extracted fields relevant to matching. Any may be null — an
 *  extraction still in flight, or one Claude simply couldn't read a field
 *  from, must not crash scoring, only score that dimension as 0. */
export interface MatchableDocument {
  vendorName: string | null
  totalAmount: number | null
  invoiceDate: string | null
  invoiceNumber: string | null
  /**
   * Redesign plan §10: the `vendor_id` that this document's normalized OCR
   * vendor name resolves to via a learned `vendor_alias` row, if any —
   * looked up ONCE per document by the caller (`rankCandidates`'s two call
   * sites, `lib/actions/documents.ts`'s `getInboxMatchCandidates` and
   * `app/(app)/review/page.tsx`'s per-bill query), never inside this module.
   * `lib/matching.ts` stays pure/DB-free by design (see the file header) —
   * this field is how a DB fact ("we've seen this exact OCR spelling
   * before, for this vendor") reaches scoring without an I/O call per
   * candidate entry. `undefined`/`null` means "no alias found" and the
   * vendor sub-score falls through to the existing fuzzy path unchanged —
   * same optional-field convention as `MatchableEntry.adminHeadId`/`zoneId`
   * above, so existing callers/tests that don't know about aliases are
   * unaffected.
   */
  vendorAliasVendorId?: number | null
}

/** An entry candidate, carrying both the fields scoring reads and the
 *  fields the inbox card displays — kept on one type so `rankCandidates`
 *  can return exactly what the UI needs without a second lookup. */
export interface MatchableEntry {
  id: number
  vendorRaw: string | null
  amount: number | null
  date: string | null
  invoiceNumber: string | null
  departmentId: number | null
  ubblNumber: string
  mainNumber: string | null
  /**
   * Pure passthrough for the attach-time zone/admin-head prompt (checklist
   * 5.11, plan §8 Z2) — not read by any scoring function below, only
   * carried through `scoreEntry`'s `{ ...entry, ... }` spread so
   * `ScoredEntry` has them for free. Optional so the existing unit tests'
   * `entry()` helper (test/unit/matching.test.ts) doesn't need updating.
   */
  adminHeadId?: number | null
  zoneId?: number | null
  /**
   * Redesign plan §10: this entry's resolved vendor identity (`entries.vendor_id`),
   * carried through so scoring can compare it against
   * `MatchableDocument.vendorAliasVendorId`. Optional for the same reason as
   * `adminHeadId`/`zoneId` above — the existing unit tests' `entry()` helper
   * doesn't set it, and a caller that doesn't fetch `vendor_id` simply never
   * gets the alias short-circuit, falling through to fuzzy scoring exactly
   * as before this change.
   */
  vendorId?: number | null
}

export interface ScoredEntry extends MatchableEntry {
  score: number
  vendorScore: number
  amountScore: number
  dateScore: number
  invoiceNumberScore: number
}

/** Weights sum to 1 — vendor still carries the most weight because amount
 *  and date proximity alone produce coincidental matches at this document
 *  volume (two unrelated ₹45,000 invoices three days apart is not rare).
 *  Invoice number sits second: when both sides have one and they match, it's
 *  a sharper signal than vendor-name fuzziness alone (redesign plan §9) —
 *  but it's still frequently blank on the entries side (a department may
 *  not have typed one in), so it can't outweigh vendor/amount/date the way
 *  an exact-match short-circuit would. Missing on either side just scores 0
 *  for this dimension, same as every other field here — no special-casing. */
const VENDOR_WEIGHT = 0.4
const AMOUNT_WEIGHT = 0.2
const DATE_WEIGHT = 0.15
const INVOICE_NUMBER_WEIGHT = 0.25

/** Below this combined score a "match" is closer to noise than a signal —
 *  excluded rather than shown as a weak top-3 candidate. Judgment call, not
 *  spec: tuned so a strong vendor match with no amount/date data (score 0.5)
 *  still surfaces, but two merely-plausible partial matches do not. */
const DEFAULT_MIN_SCORE = 0.35
const DEFAULT_LIMIT = 3

function bigrams(value: string): string[] {
  if (value.length < 2) return value.length === 1 ? [value] : []
  const grams: string[] = []
  for (let i = 0; i < value.length - 1; i++) grams.push(value.slice(i, i + 2))
  return grams
}

/**
 * Bigram Dice coefficient of two free-text vendor names, after running both
 * through `normalizeVendorName` (MASTER-PLAN §3.2) so casing, punctuation,
 * and legal suffixes never count as a difference. Returns 0..1.
 */
export function vendorSimilarity(a: string, b: string): number {
  const na = normalizeVendorName(a)
  const nb = normalizeVendorName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1

  const gramsA = bigrams(na)
  const gramsB = bigrams(nb)
  if (gramsA.length === 0 || gramsB.length === 0) return 0

  const remaining = new Map<string, number>()
  for (const g of gramsA) remaining.set(g, (remaining.get(g) ?? 0) + 1)

  let intersection = 0
  for (const g of gramsB) {
    const count = remaining.get(g) ?? 0
    if (count > 0) {
      intersection++
      remaining.set(g, count - 1)
    }
  }

  return (2 * intersection) / (gramsA.length + gramsB.length)
}

/** 1 at an exact match, degrading linearly to 0 at a 25% relative
 *  difference (measured against the larger of the two amounts). */
export function amountProximityScore(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return 0
  const diff = Math.abs(a - b)
  const larger = Math.max(a, b)
  const ratio = diff / larger
  return Math.max(0, 1 - ratio / 0.25)
}

/** 1 on the same calendar day, degrading linearly to 0 at 21 days apart. */
export function dateProximityScore(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime()
  const b = new Date(bIso).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  const days = Math.abs(a - b) / 86_400_000
  return Math.max(0, 1 - days / 21)
}

/** 1 if two invoice numbers are equal after normalization, 0 otherwise —
 *  unlike vendor names, a partial overlap between two invoice/account
 *  numbers isn't a meaningful signal, so this is binary rather than fuzzy.
 *  Normalization strips everything but letters/digits and uppercases, so
 *  "INV-045" and "inv 045" still count as the same number. */
export function invoiceNumberMatch(a: string, b: string): number {
  const na = a.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  const nb = b.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (!na || !nb) return 0
  return na === nb ? 1 : 0
}

/**
 * Vendor sub-score for one candidate entry (redesign plan §10): a learned
 * `vendor_alias` is a deterministic, exact identity signal — when the
 * document's OCR vendor name has been recorded before (via a prior attach's
 * `learnVendorAliasesFromAttach`, `lib/actions/review.ts`) as an alias
 * pointing at THIS candidate's own `vendor_id`, that's a confident match
 * (1.0), no fuzzy comparison needed. Added as an extra deterministic layer
 * in front of the existing fuzzy path, same shape as `invoiceNumberMatch`
 * (§9) — when there's no alias, or the alias points at a different vendor
 * than this candidate, falls through to `vendorSimilarity` completely
 * unchanged.
 */
function vendorScoreFor(doc: MatchableDocument, entry: MatchableEntry): number {
  if (
    doc.vendorAliasVendorId !== null &&
    doc.vendorAliasVendorId !== undefined &&
    entry.vendorId !== null &&
    entry.vendorId !== undefined &&
    entry.vendorId === doc.vendorAliasVendorId
  ) {
    return 1
  }
  return doc.vendorName && entry.vendorRaw ? vendorSimilarity(doc.vendorName, entry.vendorRaw) : 0
}

export function scoreEntry(doc: MatchableDocument, entry: MatchableEntry): ScoredEntry {
  const vendorScore = vendorScoreFor(doc, entry)
  const amountScore =
    doc.totalAmount !== null && entry.amount !== null
      ? amountProximityScore(doc.totalAmount, entry.amount)
      : 0
  const dateScore =
    doc.invoiceDate && entry.date ? dateProximityScore(doc.invoiceDate, entry.date) : 0
  const invoiceNumberScore =
    doc.invoiceNumber && entry.invoiceNumber ? invoiceNumberMatch(doc.invoiceNumber, entry.invoiceNumber) : 0

  const score =
    vendorScore * VENDOR_WEIGHT +
    amountScore * AMOUNT_WEIGHT +
    dateScore * DATE_WEIGHT +
    invoiceNumberScore * INVOICE_NUMBER_WEIGHT

  return { ...entry, score, vendorScore, amountScore, dateScore, invoiceNumberScore }
}

/**
 * Scores every candidate entry against one document and returns the top
 * matches (default: top 3, score ≥ 0.35), highest score first.
 */
export function rankCandidates(
  doc: MatchableDocument,
  entries: MatchableEntry[],
  opts?: { limit?: number; minScore?: number }
): ScoredEntry[] {
  const limit = opts?.limit ?? DEFAULT_LIMIT
  const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE

  return entries
    .map((entry) => scoreEntry(doc, entry))
    .filter((scored) => scored.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}
