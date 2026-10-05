-- Report data gaps, Phase 4: back-fill vendor.gstin / vendor.phone from bills.
--
-- All 484 vendor rows had blank gstin and phone, so v_vendor_shared_identity_edges
-- (Related-party Clusters) had nothing to join on. Bills carry both values.
--
-- Bill -> vendor goes through entry_bill_link -> entries.vendor_id. Verified
-- bills are preferred: if a vendor has any verified bill carrying a value, only
-- verified bills count for that vendor.
--
-- Rules (approved 2026-10-05):
--   * Fill only where the vendor column is blank. Never overwrite.
--   * Fill only vendors whose bills agree on exactly ONE value. Vendors with
--     conflicting values (mostly 1-character OCR misreads) are left for a human.
--   * GSTIN: must be 15 characters. A checksum-failing GSTIN is kept as read
--     (a reviewer fixes the character); non-GSTIN junk (PANs, "9") is skipped.
--   * Phone: digits only, last 10 digits, at least 10 digits on the bill.

with bill as (
  select distinct
    e.vendor_id,
    de.id as bill_id,
    de.verified_at is not null as verified,
    nullif(upper(regexp_replace(coalesce(de.vendor_gstin_verified, de.vendor_gstin_ocr), '\s', '', 'g')), '') as gstin
  from public.document_extraction de
  join public.entry_bill_link l on l.document_extraction_id = de.id
  join public.entries e on e.id = l.entry_id
  where e.vendor_id is not null
),
pool as (
  select b.*
  from bill b
  where b.gstin is not null
    and (b.verified or not exists (
      select 1 from bill v where v.vendor_id = b.vendor_id and v.verified and v.gstin is not null
    ))
),
single as (
  select vendor_id, min(gstin) as gstin
  from pool
  group by vendor_id
  having count(distinct gstin) = 1
)
update public.vendor v
set gstin = s.gstin
from single s
where v.id = s.vendor_id
  and length(s.gstin) = 15
  and (v.gstin is null or trim(v.gstin) = '');

with bill as (
  select distinct
    e.vendor_id,
    de.id as bill_id,
    de.verified_at is not null as verified,
    regexp_replace(coalesce(de.vendor_phone_verified, de.vendor_phone_ocr, ''), '\D', '', 'g') as digits
  from public.document_extraction de
  join public.entry_bill_link l on l.document_extraction_id = de.id
  join public.entries e on e.id = l.entry_id
  where e.vendor_id is not null
),
valid as (
  select vendor_id, bill_id, verified, right(digits, 10) as phone
  from bill
  where length(digits) >= 10
),
pool as (
  select p.*
  from valid p
  where p.verified or not exists (
    select 1 from valid v where v.vendor_id = p.vendor_id and v.verified
  )
),
single as (
  select vendor_id, min(phone) as phone
  from pool
  group by vendor_id
  having count(distinct phone) = 1
)
update public.vendor v
set phone = s.phone
from single s
where v.id = s.vendor_id
  and (v.phone is null or trim(v.phone) = '');
