/**
 * Document-to-entry matching (MASTER-PLAN §5 row 6, §11.2 Day 3): "suggested
 * matches on vendor + amount + date proximity."
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
}

/** An entry candidate, carrying both the fields scoring reads and the
 *  fields the inbox card displays — kept on one type so `rankCandidates`
 *  can return exactly what the UI needs without a second lookup. */
export interface MatchableEntry {
  id: number
  vendorRaw: string | null
  amount: number | null
  date: string | null
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
}

export interface ScoredEntry extends MatchableEntry {
  score: number
  vendorScore: number
  amountScore: number
  dateScore: number
}

/** Weights sum to 1 — vendor carries the most weight because amount and
 *  date proximity alone produce coincidental matches at this document
 *  volume (two unrelated ₹45,000 invoices three days apart is not rare). */
const VENDOR_WEIGHT = 0.5
const AMOUNT_WEIGHT = 0.3
const DATE_WEIGHT = 0.2

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

export function scoreEntry(doc: MatchableDocument, entry: MatchableEntry): ScoredEntry {
  const vendorScore =
    doc.vendorName && entry.vendorRaw ? vendorSimilarity(doc.vendorName, entry.vendorRaw) : 0
  const amountScore =
    doc.totalAmount !== null && entry.amount !== null
      ? amountProximityScore(doc.totalAmount, entry.amount)
      : 0
  const dateScore =
    doc.invoiceDate && entry.date ? dateProximityScore(doc.invoiceDate, entry.date) : 0

  const score = vendorScore * VENDOR_WEIGHT + amountScore * AMOUNT_WEIGHT + dateScore * DATE_WEIGHT

  return { ...entry, score, vendorScore, amountScore, dateScore }
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
