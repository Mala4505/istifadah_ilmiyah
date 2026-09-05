-- Performance remediation plan (docs/performance-remediation-plan.md) 4.4 --
-- root cause (B): v_tax_credit_exposure's `bill_tax` CTE
-- (20260903000008_related_party_gstin_views.sql:129-144) selected from
-- public.document_extraction with NO where clause at all, running a
-- correlated `exists` against reconciliation_exception for every bill ever
-- extracted -- including bills with no linked entry, a voided entry, or no
-- tax charged, none of which can ever appear in this view's output anyway
-- (bill_entry, the next CTE, throws all of those away with an inner join to
-- entries and a `tax_amount > 0` filter). The 1.1 partial indexes
-- (recon_exception_open_extraction_idx) help the EXISTS itself, but do
-- nothing to stop it running once per historical row.
--
-- lib/reports/surfaces/related-party-gstin.ts's loadRelatedPartyGstin filters
-- this view `.eq('event_id', eventId)` at the call site, so the final result
-- IS already event-scoped downstream -- but event_id isn't resolvable until
-- bill_entry joins to entries, so the view itself cannot push an event
-- filter into bill_tax (views take no parameters in Postgres, and event_id
-- lives on entries, not document_extraction).
--
-- Two changes, preserving the view's exact output columns and
-- security_invoker = true:
--
-- 1. Push document_extraction's own tax_amount / entry-join / is_void
--    filters BEFORE the EXISTS runs, not after. This is a pure
--    correctness-preserving reorder -- bill_entry already discarded these
--    rows unconditionally, so pruning them first changes the plan, not the
--    result: a bill with no linked entry, a voided entry, or null/zero tax
--    now never reaches the EXISTS at all.
--
-- 2. JUDGEMENT CALL, not purely correctness-preserving -- flagged
--    explicitly per this item's own instructions: also bound
--    document_extraction by a rolling 2-year window on created_at, the same
--    pattern and the same window 1.3 used to bound v_review_queue_all
--    (20260904000001_review_queue_perf_rewrite.sql). Filter pushdown alone
--    (point 1) removes the *noise* (unlinked/void/untaxed bills) but does
--    NOT bound the *valid* population -- a corpus of real, taxed, non-void
--    bills still grows the EXISTS count without limit as more events
--    accumulate over years, which is the actual "grows forever" complaint
--    this item is about. Unlike 1.3, this bound was NOT separately
--    confirmed with the user in this session (no live DB / no interactive
--    round trip was available) -- it mirrors an already-accepted precedent
--    rather than a fresh product decision. Risk: a selected event older
--    than 2 years would make this view read as entirely empty for that
--    event rather than erroring -- a silent-truncation shape, same class of
--    risk 1.3's own note called out. Confirm acceptable before applying to
--    a live corpus that has (or will have) events beyond that window; widen
--    or drop the window first if not.
create or replace view public.v_tax_credit_exposure with (security_invoker = true) as
with bill_candidate as (
  select
    de.id as document_extraction_id,
    coalesce(de.entry_id, sd.entry_id) as entry_id,
    coalesce(de.tax_amount_verified, de.tax_amount_ocr) as tax_amount
  from public.document_extraction de
  left join public.source_document sd on sd.id = de.source_document_id
  where de.created_at > now() - interval '2 years'
    and coalesce(de.tax_amount_verified, de.tax_amount_ocr) is not null
    and coalesce(de.tax_amount_verified, de.tax_amount_ocr) > 0
),
bill_entry_prefilter as (
  select
    bc.document_extraction_id,
    bc.tax_amount,
    e.vendor_id,
    v.display_name as vendor_display_name,
    e.department_id,
    d.name as department_name,
    e.event_id
  from bill_candidate bc
  join public.entries e on e.id = bc.entry_id
  left join public.vendor v on v.id = e.vendor_id
  left join public.department d on d.id = e.department_id
  where e.is_void = false
),
bill_entry as (
  -- The correlated EXISTS now runs only against the pre-filtered,
  -- entry-linked, non-void, positive-tax, 2-year-bounded set above --
  -- exactly the rows that can ever reach the final aggregate -- rather than
  -- every document_extraction row that has ever existed.
  select
    bep.*,
    exists (
      select 1
      from public.reconciliation_exception re
      where re.document_extraction_id = bep.document_extraction_id
        and re.status = 'open'
        and re.exception_type in ('vendor_gstin_invalid_checksum', 'gst_recipient_compliance_missing')
    ) as has_open_credit_exception
  from bill_entry_prefilter bep
)
select
  vendor_id,
  vendor_display_name,
  department_id,
  department_name,
  event_id,
  count(*) as bill_count,
  coalesce(sum(tax_amount), 0) as total_tax_amount,
  coalesce(sum(tax_amount) filter (where has_open_credit_exception), 0) as at_risk_tax_amount,
  coalesce(sum(tax_amount) filter (where not has_open_credit_exception), 0) as claimable_tax_amount
from bill_entry
group by vendor_id, vendor_display_name, department_id, department_name, event_id;

-- CREATE OR REPLACE VIEW does not revoke existing grants (20260814000009's
-- note, restated in 20260904000001) -- the 20260903000008 grant to
-- authenticated already covers this view; no re-grant needed here.
