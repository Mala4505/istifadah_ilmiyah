-- reporting-blueprint.md Phase 5, Family B: B-07 Related-party cluster map,
-- B-08 GSTIN validity & tax exposure.
--
-- v_vendor_shared_identity_edges -- B-07. "Distinct vendor names sharing a
-- GSTIN, phone number or address." vendor.cluster_group_id (self-ref,
-- 20260808000008_vendor_and_alias.sql) may exist from a manual-merge
-- pipeline, but the automated clustering pass that would populate it at
-- scale has not run against the live corpus -- relying on it alone would
-- silently miss most real overlaps. Instead this computes shared-identity
-- edges directly off vendor's own gstin/phone/address columns: any two
-- DISTINCT vendor rows that agree on a non-null gstin, OR a non-null phone,
-- OR a non-null normalized (trim/lower) address are an edge -- one row per
-- (pair, reason), so a pair sharing both a GSTIN and a phone yields two
-- edges, not one merged row (the app-side Union-Find only needs "these two
-- are connected somehow"; which reasons is exactly what the edge table is
-- for). Connected-component grouping (which edges chain into one cluster,
-- transitively) happens app-side in the loader -- Postgres has no clean
-- built-in for transitive closure over an edge list, and these graphs are
-- small (tens of vendors, not thousands).
--
-- No event_id column: vendor identity (GSTIN/phone/address) is a property of
-- the vendor row itself, not of any one event's activity -- same reasoning
-- v_vendor_concentration documents for vendor.is_confirmed being an
-- unscoped, whole-corpus property. A department-scoped reviewer sees every
-- edge regardless of department: vendor is staff-wide SELECT with no
-- department scoping (deliberate cross-department comparison, per
-- 20260903000002_phase_four_finding_views.sql's header), and this view
-- inherits that same property unchanged.
--
-- v_tax_credit_exposure -- B-08. "Tax charged, against the share of it where
-- the vendor GSTIN passes checksum and our own GSTIN appears on the bill.
-- The gap is credit that may not be claimable." Per (vendor, department,
-- event): total tax charged, the slice sitting on a bill carrying an OPEN
-- 'vendor_gstin_invalid_checksum' or 'gst_recipient_compliance_missing'
-- exception (not cleanly claimable), and the claimable remainder.
--
-- Both exception type strings and their raise sites were confirmed by grep
-- against lib/jobs/handlers/extract.ts (20260820000002_gstin_checksum_and_page_failure_exceptions.sql,
-- 20260821000007_gst_recipient_compliance.sql), not assumed:
--   - 'vendor_gstin_invalid_checksum' (severity low) -- the extracted seller
--     GSTIN fails its own check-digit; the value is kept as-read (never
--     blanked) so a reviewer can fix the misread character.
--   - 'gst_recipient_compliance_missing' (severity high) -- GST was charged
--     on the bill but our own GSTIN/name/invoice number don't clearly appear
--     on it, so the input tax credit is not safely claimable. (The sibling
--     'recipient_identity_missing' type covers the no-GST-charged case --
--     irrelevant here since there is no tax to claim credit against.)
-- Both are raised against document_extraction_id, never entry_id, and their
-- upsert payloads in extract.ts write only
-- document_extraction_id/exception_type/severity/description/dedup_key --
-- reconciliation_exception.amount_at_risk is NOT populated on either type's
-- insert. So this view cannot sum amount_at_risk the way
-- v_exception_heatmap does for other issue types -- it derives the at-risk
-- rupee figure itself from document_extraction's own tax_amount, keyed by
-- whether that specific bill currently carries one of the two open
-- exceptions (an `exists` correlated to document_extraction_id, re-evaluated
-- live so a resolved exception -- e.g. lib/actions/review.ts's
-- auto-resolve-on-corrected-GSTIN -- moves its bill back to "claimable"
-- without a backfill).
--
-- Grain: one row per document_extraction (bill) with tax charged, rolled up
-- into (vendor, department, event) -- an entry with multiple bills sums
-- across all of them ("total tax_amount charged" is additive), unlike
-- v_instrument_type_mix's categorical mix (20260903000002) which picks one
-- representative bill per entry -- a sum has no "representative" to pick.
-- entry_id resolution mirrors v_instrument_type_mix exactly: source_document
-- sd on sd.entry_id = e.id, document_extraction de on de.source_document_id
-- = sd.id and coalesce(de.entry_id, sd.entry_id) = e.id. vendor_id/
-- department_id/event_id all come from entries, which IS department-scoped
-- by RLS (can_see_department) -- a department-scoped reviewer sees only
-- their own department's bills through this view, same property
-- v_rate_observation documents for its own vendor+department+event grain.
--
-- security_invoker = true on both (every view in this codebase runs as the
-- calling user so base-table RLS applies); both are new objects the
-- 20260808000026 blanket grant predates, so each needs its own explicit
-- grant below.

-- ----------------------------------------------------------------------------
-- v_vendor_shared_identity_edges -- B-07
-- ----------------------------------------------------------------------------
create view public.v_vendor_shared_identity_edges with (security_invoker = true) as
with gstin_edges as (
  select
    a.id as vendor_id_a,
    a.display_name as vendor_name_a,
    b.id as vendor_id_b,
    b.display_name as vendor_name_b,
    'gstin'::text as shared_on,
    a.gstin as shared_value
  from public.vendor a
  join public.vendor b on b.gstin = a.gstin and b.id > a.id
  where a.gstin is not null and trim(a.gstin) <> ''
),
phone_edges as (
  select
    a.id as vendor_id_a,
    a.display_name as vendor_name_a,
    b.id as vendor_id_b,
    b.display_name as vendor_name_b,
    'phone'::text as shared_on,
    a.phone as shared_value
  from public.vendor a
  join public.vendor b on b.phone = a.phone and b.id > a.id
  where a.phone is not null and trim(a.phone) <> ''
),
address_edges as (
  select
    a.id as vendor_id_a,
    a.display_name as vendor_name_a,
    b.id as vendor_id_b,
    b.display_name as vendor_name_b,
    'address'::text as shared_on,
    trim(lower(a.address)) as shared_value
  from public.vendor a
  join public.vendor b
    on trim(lower(b.address)) = trim(lower(a.address)) and b.id > a.id
  where a.address is not null and trim(a.address) <> ''
)
select vendor_id_a, vendor_name_a, vendor_id_b, vendor_name_b, shared_on, shared_value from gstin_edges
union all
select vendor_id_a, vendor_name_a, vendor_id_b, vendor_name_b, shared_on, shared_value from phone_edges
union all
select vendor_id_a, vendor_name_a, vendor_id_b, vendor_name_b, shared_on, shared_value from address_edges;

-- ----------------------------------------------------------------------------
-- v_tax_credit_exposure -- B-08
-- ----------------------------------------------------------------------------
create view public.v_tax_credit_exposure with (security_invoker = true) as
with bill_tax as (
  select
    de.id as document_extraction_id,
    coalesce(de.entry_id, sd.entry_id) as entry_id,
    coalesce(de.tax_amount_verified, de.tax_amount_ocr) as tax_amount,
    exists (
      select 1
      from public.reconciliation_exception re
      where re.document_extraction_id = de.id
        and re.status = 'open'
        and re.exception_type in ('vendor_gstin_invalid_checksum', 'gst_recipient_compliance_missing')
    ) as has_open_credit_exception
  from public.document_extraction de
  left join public.source_document sd on sd.id = de.source_document_id
),
bill_entry as (
  select
    bt.tax_amount,
    bt.has_open_credit_exception,
    e.vendor_id,
    v.display_name as vendor_display_name,
    e.department_id,
    d.name as department_name,
    e.event_id
  from bill_tax bt
  join public.entries e on e.id = bt.entry_id
  left join public.vendor v on v.id = e.vendor_id
  left join public.department d on d.id = e.department_id
  where e.is_void = false
    and bt.tax_amount is not null
    and bt.tax_amount > 0
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

-- Brand-new objects; not covered by the historical blanket grant.
grant select on public.v_vendor_shared_identity_edges, public.v_tax_credit_exposure to authenticated;
