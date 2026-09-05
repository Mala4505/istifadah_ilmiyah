-- Performance remediation plan (docs/performance-remediation-plan.md) Phase 4
-- -- root cause (B): whole-ledger fuzzy matching executed in the request
-- path. app/(app)/review/page.tsx and lib/actions/documents.ts's
-- getInboxMatchCandidates both fetched up to 5,000 non-void `entries` rows
-- (ordered by date desc) and scored every one of them in JS via
-- lib/matching.ts's rankCandidates. Three problems, worst first:
--   1. Correctness bug: the .limit(5000) silently makes older entries
--      unreachable as match suggestions once the ledger exceeds that size --
--      no error, no warning.
--   2. Up to 5,000 entries_select RLS evaluations of
--      private.can_see_department() per bill opened.
--   3. 5,000 rows over the wire, every time.
--
-- Fix: this function pre-filters candidates by indexed/cheap conditions --
-- exact vendor_id, amount within a padded proximity window, normalized
-- invoice-number exact match, or vendor-name trigram similarity -- BEFORE any
-- fuzzy scoring, and returns a small set for rankCandidates to do final
-- scoring/top-N selection on in JS, exactly as before. SECURITY INVOKER so
-- RLS (entries_select) still applies per-row, scoped to the calling role.
--
-- Not verified against a live query plan -- no Supabase connection available
-- in this session (same limitation Phase 1's own header notes). CREATE INDEX
-- CONCURRENTLY cannot run inside a transaction block -- see 20260904000001's
-- note if your migration runner wraps this file in an implicit transaction.

-- ---------------------------------------------------------------------------
-- Supporting indexes.
-- ---------------------------------------------------------------------------

-- Amount-proximity pre-filter below is rewritten from the ratio form
-- (abs(a-b)/greatest(a,b) <= 0.3) into an equivalent sargable range
-- (a between p*0.7 and p/0.7) so a plain btree on amount can drive it --
-- see the function body for the derivation. entries_vendor_idx and
-- entries_invoice_number_idx already index the other two exact-match
-- branches; amount had no is_void-scoped index (entries_date_idx's sibling,
-- entries_active_date_idx from 1.5, covers date but not amount).
CREATE INDEX CONCURRENTLY IF NOT EXISTS entries_active_amount_idx
  ON public.entries (amount)
  WHERE is_void = false AND amount IS NOT NULL;

-- Normalized invoice-number exact match: lib/matching.ts's
-- invoiceNumberMatch strips everything but letters/digits and uppercases
-- before comparing, so a raw-column index on entries.invoice_number
-- (entries_invoice_number_idx, 20260808000014) can't serve an equality
-- lookup on the normalized value. Expression index, same transform as the
-- function body below -- must match verbatim for the planner to use it.
CREATE INDEX CONCURRENTLY IF NOT EXISTS entries_invoice_number_normalized_idx
  ON public.entries (upper(regexp_replace(invoice_number, '[^A-Za-z0-9]', '', 'g')))
  WHERE invoice_number IS NOT NULL;

-- Vendor-name trigram similarity pre-filter. pg_trgm lives in the
-- `extensions` schema (20260813000007) -- the opclass is schema-qualified
-- here the same way 20260814000001_item_catalog.sql's item_family/
-- item_catalog trgm indexes already do. lower(vendor_raw) rather than the
-- raw column: pg_trgm similarity is case-sensitive and entries.vendor_raw
-- (unlike vendor.normalized_name) is stored exactly as exported/OCR'd, so
-- casing differences between the two sides would otherwise depress the
-- score for no reason.
CREATE INDEX CONCURRENTLY IF NOT EXISTS entries_vendor_raw_trgm_idx
  ON public.entries USING gin (lower(vendor_raw) extensions.gin_trgm_ops)
  WHERE vendor_raw IS NOT NULL;

-- ---------------------------------------------------------------------------
-- match_candidate_entries -- the pre-filter RPC.
--
-- Deliberately no hard row cap as the primary bound (that's the correctness
-- bug being fixed) -- the four OR branches below are each indexed/cheap and
-- narrow, by construction, to plausible candidates rather than "the 5,000
-- most recent rows regardless of relevance". The final LIMIT 300 is a
-- last-resort safety valve for a pathological case (e.g. an extremely
-- common vendor name with thousands of loosely-similar entries), not a
-- correctness boundary -- judgment call per the plan's own allowance for
-- "a few hundred, not 5000". Ordered so the strongest signals (exact vendor,
-- exact invoice number) survive that cap first if it ever triggers; final
-- ranking/top-N is still rankCandidates' job in JS on the result.
--
-- Matched-entry exclusion is done here via NOT EXISTS against
-- source_document rather than the caller passing an excluded-id array --
-- both call sites used to run a separate `source_document` query and build
-- a JS Set for this same check, which this function now absorbs, removing
-- that round trip from both callers entirely.
-- ---------------------------------------------------------------------------
create or replace function public.match_candidate_entries(
  p_vendor_id bigint default null,
  p_amount numeric default null,
  p_invoice_number text default null,
  p_vendor_raw text default null
)
returns table (
  id bigint,
  vendor_raw text,
  vendor_id bigint,
  amount numeric,
  date date,
  invoice_number text,
  department_id bigint,
  ubbl_number text,
  main_number text,
  admin_head_id bigint,
  zone_id bigint
)
language plpgsql
stable
security invoker
set search_path = ''
-- Loosened past pg_trgm's default 0.3 -- this is a pre-filter meant to be a
-- superset of what final scoring (lib/matching.ts's vendorSimilarity, a
-- separate bigram-Dice measure over normalizeVendorName output) would
-- accept, not the final similarity gate. Judgment call, not spec.
set pg_trgm.similarity_threshold = 0.15
as $$
declare
  v_invoice_number_normalized text :=
    nullif(upper(regexp_replace(coalesce(p_invoice_number, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_vendor_raw_normalized text := nullif(lower(trim(coalesce(p_vendor_raw, ''))), '');
begin
  return query
  select
    e.id, e.vendor_raw, e.vendor_id, e.amount, e.date, e.invoice_number,
    e.department_id, e.ubbl_number, e.main_number, e.admin_head_id, e.zone_id
  from public.entries e
  where e.is_void = false
    and not exists (
      select 1 from public.source_document sd
      where sd.entry_id = e.id and sd.match_status = 'matched'
    )
    and (
      -- Exact vendor_id match (redesign plan §10's vendor_alias
      -- short-circuit, resolved by the caller before this call).
      (p_vendor_id is not null and e.vendor_id = p_vendor_id)

      -- Amount within lib/matching.ts's amountProximityScore non-zero
      -- window, padded past its 0.25 cutoff to 0.3 since this is a
      -- pre-filter, not the final scorer. abs(a-b)/greatest(a,b) <= 0.3
      -- rewritten as the equivalent range a in [p*0.7, p/0.7] (derivation:
      -- split on which of a/p is larger, solve each branch, the two
      -- half-open ranges join into one closed range) so a plain btree scan
      -- on amount can serve it instead of evaluating the ratio per row.
      or (
        p_amount is not null and e.amount is not null
        and p_amount > 0 and e.amount > 0
        and e.amount between p_amount * 0.7 and p_amount / 0.7
      )

      -- Invoice number exact match after the same normalization
      -- lib/matching.ts's invoiceNumberMatch applies (strip non-alphanumeric,
      -- uppercase).
      or (
        v_invoice_number_normalized is not null
        and upper(regexp_replace(e.invoice_number, '[^A-Za-z0-9]', '', 'g')) = v_invoice_number_normalized
      )

      -- Vendor name trigram similarity, GIN-index-backed via the `%`
      -- operator (schema-qualified since this function runs with
      -- search_path = '') rather than a leading-wildcard ILIKE.
      or (
        v_vendor_raw_normalized is not null
        and e.vendor_raw is not null
        and lower(e.vendor_raw) OPERATOR(extensions.%) v_vendor_raw_normalized
      )
    )
  order by
    (p_vendor_id is not null and e.vendor_id = p_vendor_id) desc,
    (
      v_invoice_number_normalized is not null
      and upper(regexp_replace(e.invoice_number, '[^A-Za-z0-9]', '', 'g')) = v_invoice_number_normalized
    ) desc,
    e.date desc nulls last
  limit 300;
end;
$$;

-- Belt and braces, same pattern as public.upsert_flag (20260814000004): even
-- under SECURITY INVOKER (so this can never read more than the calling
-- role's own RLS-scoped view of entries/source_document), there's no reason
-- for this to be reachable by anon or the default PUBLIC grant Supabase
-- attaches to newly created functions.
revoke all on function public.match_candidate_entries(bigint, numeric, text, text)
  from public, anon, authenticated;

grant execute on function public.match_candidate_entries(bigint, numeric, text, text)
  to authenticated;
