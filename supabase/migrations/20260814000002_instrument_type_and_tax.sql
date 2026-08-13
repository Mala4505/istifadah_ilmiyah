-- Phase 2 -- what KIND of document this is, and how tax was actually charged.
--
-- document_extraction (20260808000021) captures a single `tax_amount` and nothing about
-- the instrument itself. Reading the pilot corpus showed that is the missing distinction
-- the whole compliance analysis turns on. Of eight vendors, four charged no GST -- but for
-- three different reasons that carry three different consequences:
--
--   Tax Invoice, GSTIN present, IGST 18%   -> ITC claimable, nothing to do
--   Bill of Supply, no GSTIN               -> supplier is composition/exempt; ITC never
--                                             claimable; legitimate but must not be
--                                             treated as a missing-tax error
--   Retail cash memo / letterhead bill     -> supplier is unregistered; ITC lost, and
--                                             above the s.194C limits TDS should have
--                                             been deducted at source
--
-- Without instrument_type all three collapse into "tax_amount is null" and the engine
-- either flags all of them (two false positives) or none (one real leak missed). The
-- ~Rs 92,000 letterhead bill in the pilot corpus is the third case.
--
-- Follows the _ocr / _verified twin-column pattern of the parent table (§9.2): the model's
-- guess is never overwritten, so v_extraction_correction keeps working and instrument_type
-- accuracy becomes measurable against gold.json for free.

alter table public.document_extraction
  add column instrument_type_ocr text,
  add column instrument_type_verified text,
  -- Per-component tax, because a single tax_amount cannot answer "was the right KIND of
  -- GST charged". A Gujarat supplier billing a Maharashtra buyer must charge IGST; the
  -- same supplier billing within Gujarat must charge CGST+SGST. Getting this backwards is
  -- a real and common error that makes the ITC unclaimable, and it is invisible unless the
  -- components are stored separately.
  --   {"cgst": {"rate": 9, "amount": 270}, "sgst": {...}, "igst": null, "cess": null}
  -- jsonb rather than six columns: most invoices populate either the igst branch or the
  -- cgst/sgst pair, never both, so columns would be half-null on every row.
  add column tax_breakdown_ocr jsonb,
  add column tax_breakdown_verified jsonb,
  -- The other half of the interstate test. Printed on GST invoices as "Place of Supply".
  add column place_of_supply_ocr text,
  add column place_of_supply_verified text,
  -- Rounding line, kept separate so it stops polluting tax_math_mismatch. Several invoices
  -- in the corpus carry an explicit "Round Off" row; without capturing it the subtotal +
  -- tax = total check fails by up to a rupee on perfectly correct invoices.
  add column round_off_ocr numeric(8,2),
  add column round_off_verified numeric(8,2);

-- Values are drawn from what the corpus actually contains, not from a general taxonomy.
-- 'letterhead_bill' is distinct from 'retail_cash_memo' because the former is a formal
-- itemised bill from an unregistered supplier (and is typically large -- the s.194C TDS
-- case) while the latter is an over-the-counter slip (typically small).
alter table public.document_extraction
  add constraint document_extraction_instrument_type_ocr_check
  check (instrument_type_ocr is null or instrument_type_ocr in (
    'tax_invoice','bill_of_supply','retail_cash_memo','letterhead_bill',
    'proforma_invoice','quotation','receipt','delivery_challan','other'));

alter table public.document_extraction
  add constraint document_extraction_instrument_type_verified_check
  check (instrument_type_verified is null or instrument_type_verified in (
    'tax_invoice','bill_of_supply','retail_cash_memo','letterhead_bill',
    'proforma_invoice','quotation','receipt','delivery_challan','other'));

-- The compliance pass scans by instrument type across the whole verified set; without this
-- it is a sequential scan of every extraction ever made.
create index document_extraction_instrument_idx
  on public.document_extraction (coalesce(instrument_type_verified, instrument_type_ocr))
  where verified_at is not null;

-- ----------------------------------------------------------------------------
-- document_page.skip_reason -- three more non-financial page kinds.
-- ----------------------------------------------------------------------------
-- The existing list ('bank_cheque','passbook','unrelated_document','blank','other') sends
-- everything else to 'unrelated_document', which is where a Gujarati land-permission letter
-- bound into one of the pilot PDFs ended up. That is wrong in a way that costs money later:
-- a permission letter is not unrelated, it is REQUIRED supporting documentation, and the
-- missing_documentation detector needs to be able to tell "this entry has its permission
-- letter" from "this entry has some page we could not read".
alter table public.document_page drop constraint document_page_skip_reason_check;
alter table public.document_page add constraint document_page_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'bank_cheque','passbook','unrelated_document','blank','other',
    'permission_letter','agreement','photo'));
