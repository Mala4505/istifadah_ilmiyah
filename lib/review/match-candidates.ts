import type { SupabaseClient } from '@supabase/supabase-js'
import { rankCandidates, type MatchableEntry } from '@/lib/matching'
import { normalizeVendorName } from '@/lib/normalize'
import { getCachedDepartments } from '@/lib/cache/reference-data'
import type { MatchCandidate } from '@/lib/review/types'

/**
 * The single place a bill's "suggested" ledger matches are computed
 * (MASTER-PLAN §7). Was inline in app/(app)/review/page.tsx's
 * loadDocumentDetail; extracted 2026-09-07 so the live re-match server
 * action (lib/actions/review.ts's refreshMatchCandidates) runs the exact
 * same pipeline rather than a second copy that can drift.
 *
 * Two deliberate behaviours, both from the 2026-09-07 discussion:
 *
 *  - **Vendor resolution order (change "C").** An explicitly linked
 *    `vendorId` (the vendor picked in the Verify step) wins outright. With
 *    none, the vendor *name* is resolved against `vendor.normalized_name`
 *    first, then `vendor_alias.raw_name` — the page load used to check only
 *    the alias table, so a vendor that simply matched by name (no learned
 *    alias yet) never got the confident exact-vendor signal. With neither,
 *    `match_candidate_entries` still pre-filters on amount / invoice number /
 *    vendor-name trigram alone.
 *
 *  - **Verified-over-OCR inputs.** Callers pass the current (edited or
 *    verified) vendor name / total / date / invoice number, not the raw OCR
 *    values, so fixing a misread field immediately re-tallies.
 *
 * Final scoring/top-N stays `lib/matching.ts`'s `rankCandidates`, unchanged.
 */
export interface MatchCandidateInput {
  /** Vendor linked in the Verify step, if any — the strongest signal. */
  vendorId: number | null
  /** Current vendor-name text (verified/edited, falling back to OCR). */
  vendorName: string | null
  totalAmount: number | null
  invoiceDate: string | null
  invoiceNumber: string | null
}

interface CandidateRow {
  id: number
  vendor_raw: string | null
  vendor_id: number | null
  amount: number | null
  date: string | null
  invoice_number: string | null
  department_id: number | null
  ubbl_number: string
  main_number: string | null
}

export async function computeMatchCandidates(
  supabase: SupabaseClient,
  input: MatchCandidateInput,
  selectedEventId: number | null,
): Promise<MatchCandidate[]> {
  const normalizedVendorName = input.vendorName ? normalizeVendorName(input.vendorName) : ''

  // Vendor resolution order: explicit link → vendor.normalized_name →
  // vendor_alias.raw_name → nothing (RPC falls back to amount/invoice/trigram).
  let resolvedVendorId = input.vendorId
  if (resolvedVendorId === null && normalizedVendorName) {
    const [{ data: byName }, { data: byAlias }] = await Promise.all([
      supabase.from('vendor').select('id').eq('normalized_name', normalizedVendorName).maybeSingle(),
      supabase.from('vendor_alias').select('vendor_id').eq('raw_name', normalizedVendorName).maybeSingle(),
    ])
    resolvedVendorId =
      (byName?.id as number | undefined) ?? (byAlias?.vendor_id as number | undefined) ?? null
  }

  const { data: candidateRows } = await supabase.rpc('match_candidate_entries', {
    p_vendor_id: resolvedVendorId,
    p_amount: input.totalAmount,
    p_invoice_number: input.invoiceNumber,
    p_vendor_raw: input.vendorName,
  })

  const candidatePool: MatchableEntry[] = ((candidateRows ?? []) as CandidateRow[]).map((e) => ({
    id: e.id,
    vendorRaw: e.vendor_raw,
    vendorId: e.vendor_id,
    amount: e.amount,
    date: e.date,
    invoiceNumber: e.invoice_number,
    departmentId: e.department_id,
    ubblNumber: e.ubbl_number,
    mainNumber: e.main_number,
  }))

  // Event-scoped department-name resolution: a candidate's department name is
  // cosmetic (helps tell similar-looking candidates apart), so it's scoped to
  // the selected event's event_department membership — a department with no
  // membership row simply comes back nameless. Matches loadDocumentDetail's
  // own prior behaviour verbatim, including "no event → no names".
  const candidateDepartmentIds = Array.from(
    new Set(candidatePool.map((c) => c.departmentId).filter((id): id is number => id !== null)),
  )
  const { data: eventDepartmentRows } =
    selectedEventId !== null && candidateDepartmentIds.length > 0
      ? await supabase.from('event_department').select('department_id').eq('event_id', selectedEventId)
      : { data: [] as { department_id: number }[] }
  const activeDepartmentIds = new Set((eventDepartmentRows ?? []).map((r) => r.department_id as number))
  const departmentIdsToResolve = candidateDepartmentIds.filter((id) => activeDepartmentIds.has(id))
  const departmentsForCandidates =
    departmentIdsToResolve.length > 0 ? await getCachedDepartments(supabase) : []
  const departmentNameById = new Map(
    departmentsForCandidates
      .filter((d) => departmentIdsToResolve.includes(d.id))
      .map((d) => [d.id, d.name]),
  )

  return rankCandidates(
    {
      vendorName: input.vendorName,
      totalAmount: input.totalAmount,
      invoiceDate: input.invoiceDate,
      invoiceNumber: input.invoiceNumber,
      vendorAliasVendorId: resolvedVendorId,
    },
    candidatePool,
  ).map((c) => ({
    entryId: c.id,
    score: c.score,
    vendorRaw: c.vendorRaw,
    amount: c.amount,
    date: c.date,
    ubblNumber: c.ubblNumber,
    mainNumber: c.mainNumber,
    departmentName: c.departmentId !== null ? (departmentNameById.get(c.departmentId) ?? null) : null,
  }))
}
