-- v_tax_credit_exposure: also count an open 'buyer_gstin_invalid_checksum'
-- as a credit-at-risk exception (2026-09-07).
--
-- The extract handler now keeps a checksum-failing recipient GSTIN as-read
-- and raises the low-severity 'buyer_gstin_invalid_checksum' exception
-- instead of nulling the value and letting it fall through to
-- 'gst_recipient_compliance_missing' (lib/jobs/handlers/extract.ts). Without
-- this change, a tax invoice whose buyer GSTIN is one OCR character off would
-- drop out of `at_risk_tax_amount` even though the input tax credit genuinely
-- is at risk until a reviewer fixes the character -- exactly the reason
-- 'vendor_gstin_invalid_checksum' is already in this list.
--
-- Full view body copied verbatim from
-- 20260905000002_tax_credit_exposure_bound.sql (the current definition); the
-- only change is the exception_type IN (...) list in the `bill_entry` CTE.
-- CREATE OR REPLACE VIEW keeps existing grants.
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
  select
    bep.*,
    exists (
      select 1
      from public.reconciliation_exception re
      where re.document_extraction_id = bep.document_extraction_id
        and re.status = 'open'
        and re.exception_type in (
          'vendor_gstin_invalid_checksum',
          'buyer_gstin_invalid_checksum',
          'gst_recipient_compliance_missing'
        )
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
