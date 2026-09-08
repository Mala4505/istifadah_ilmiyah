/**
 * Entry <-> bill variance readers (entry-bill links, Phase 5).
 *
 * Two thin reads over the Phase 2 variance views, one per grain:
 *   * getEntryBillVariance  -> v_entry_bill_variance  (entry grain): this
 *     entry's own amount vs SUM of every linked bill's total. Read by
 *     /entries/[id] and components/entries/detail/linked-documents.tsx.
 *   * getBillEntryVariance  -> v_bill_entry_variance  (bill grain): this
 *     bill's total vs SUM of every linked entry's amount. Read by /review's
 *     loadDocumentDetail and the Connect-step tally footer.
 *
 * Plain module (no 'use server') taking a caller-supplied, RLS-scoped Supabase
 * client -- same shape as lib/documents/entry-bill-kpis.ts / bill-kpis.ts -- so
 * an RSC can call it directly and the view's `security_invoker` department
 * scoping applies to the caller.
 *
 * >>> DOUBLE-COUNTING RULE (from 20260908000002) <<<
 * There is no allocation. `billedTotal` here is the FULL total of every linked
 * bill, and `linkedEntryTotal` the FULL amount of every linked entry -- correct
 * per row, but NEVER sum either across rows once a bill or entry is shared.
 * These helpers are per-entity point reads, so that rule is satisfied by
 * construction; any rollup must aggregate from `document_extraction` directly.
 *
 * Best-effort: a failed read is logged and returns `null` (the caller renders
 * the pre-variance fallback), never throws. `null` is also the honest result
 * for an entity with no `entry_bill_link` rows -- the view has no row for it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logRawError } from '@/lib/friendly-error'

/** One row of v_entry_bill_variance, camelCased. */
export interface EntryBillVariance {
  entryId: number
  entryAmount: number
  /** SUM of coalesce(verified, ocr) total over every linked bill. Per-row
   *  honest; do not sum across entries. */
  billedTotal: number
  /** entryAmount - billedTotal (signed: positive => recorded more than billed). */
  varianceAmount: number
  variancePct: number | null
  withinTolerance: boolean
  /** Distinct linked bills (document_extraction rows) with a non-null id. */
  billCount: number
  /** Distinct linked source_documents (includes pre-extraction placeholders). */
  documentCount: number
  /** Of billCount: how many have a verified total. */
  verifiedBillCount: number
}

/** One row of v_bill_entry_variance, camelCased. */
export interface BillEntryVariance {
  documentExtractionId: number
  sourceDocumentId: number
  /** coalesce(total_amount_verified, total_amount_ocr) -- an OCR read before
   *  Verify runs (say so in any caption). */
  billTotal: number | null
  /** SUM of entries.amount over every linked (non-void) entry. Per-row honest;
   *  do not sum across bills. */
  linkedEntryTotal: number
  /** billTotal - linkedEntryTotal (signed). */
  varianceAmount: number
  variancePct: number | null
  withinTolerance: boolean
  entryLinkCount: number
  entryIds: number[]
}

/**
 * Variance for one entry, or `null` when it has no linked bills / the read
 * failed. `v_entry_bill_variance` only carries rows for entries with >=1
 * `entry_bill_link`, so `null` here means "no bill linked yet".
 */
export async function getEntryBillVariance(
  supabase: SupabaseClient,
  entryId: number
): Promise<EntryBillVariance | null> {
  try {
    const { data, error } = await supabase
      .from('v_entry_bill_variance')
      .select(
        'entry_id, entry_amount, billed_total, variance_amount, variance_pct, within_tolerance, bill_count, document_count, verified_bill_count'
      )
      .eq('entry_id', entryId)
      .maybeSingle()

    if (error) {
      logRawError('documents.getEntryBillVariance', error.message)
      return null
    }
    if (!data) return null

    return {
      entryId: data.entry_id as number,
      entryAmount: Number(data.entry_amount ?? 0),
      billedTotal: Number(data.billed_total ?? 0),
      varianceAmount: Number(data.variance_amount ?? 0),
      variancePct: data.variance_pct === null ? null : Number(data.variance_pct),
      withinTolerance: Boolean(data.within_tolerance),
      billCount: Number(data.bill_count ?? 0),
      documentCount: Number(data.document_count ?? 0),
      verifiedBillCount: Number(data.verified_bill_count ?? 0),
    }
  } catch (err) {
    logRawError('documents.getEntryBillVariance', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Variance for one bill, or `null` on a failed read. Unlike the entry view,
 * `v_bill_entry_variance` carries a row for every bill (LEFT JOIN to the
 * junction), so a bill with no linked entry comes back with
 * `entryLinkCount: 0` rather than `null`.
 */
export async function getBillEntryVariance(
  supabase: SupabaseClient,
  documentExtractionId: number
): Promise<BillEntryVariance | null> {
  const rows = await getBillEntryVarianceMany(supabase, [documentExtractionId])
  return rows.get(documentExtractionId) ?? null
}

/**
 * Batched sibling of getBillEntryVariance -- one query for a set of bills,
 * returned as a Map keyed by `documentExtractionId`. Missing keys = failed
 * read (the caller falls back). Used where a screen shows several bills of the
 * same PDF at once (the bill rail).
 */
export async function getBillEntryVarianceMany(
  supabase: SupabaseClient,
  documentExtractionIds: number[]
): Promise<Map<number, BillEntryVariance>> {
  const out = new Map<number, BillEntryVariance>()
  const ids = [...new Set(documentExtractionIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return out

  try {
    const { data, error } = await supabase
      .from('v_bill_entry_variance')
      .select(
        'document_extraction_id, source_document_id, bill_total, linked_entry_total, variance_amount, variance_pct, within_tolerance, entry_link_count, entry_ids'
      )
      .in('document_extraction_id', ids)

    if (error) {
      logRawError('documents.getBillEntryVarianceMany', error.message)
      return out
    }

    for (const row of data ?? []) {
      const rawIds = (row.entry_ids ?? []) as unknown
      out.set(row.document_extraction_id as number, {
        documentExtractionId: row.document_extraction_id as number,
        sourceDocumentId: row.source_document_id as number,
        billTotal: row.bill_total === null ? null : Number(row.bill_total),
        linkedEntryTotal: Number(row.linked_entry_total ?? 0),
        varianceAmount: Number(row.variance_amount ?? 0),
        variancePct: row.variance_pct === null ? null : Number(row.variance_pct),
        withinTolerance: Boolean(row.within_tolerance),
        entryLinkCount: Number(row.entry_link_count ?? 0),
        entryIds: Array.isArray(rawIds) ? (rawIds as number[]).map(Number) : [],
      })
    }
    return out
  } catch (err) {
    logRawError('documents.getBillEntryVarianceMany', err instanceof Error ? err.message : String(err))
    return out
  }
}
