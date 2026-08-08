create table public.document_extraction (
  id bigint generated always as identity primary key,
  source_document_id bigint not null unique references public.source_document(id) on delete cascade,
  current_extraction_run_id bigint references public.ocr_extraction_run(id),

  vendor_name_ocr text,            vendor_name_verified text,
  vendor_gstin_ocr text,           vendor_gstin_verified text,       -- needed for clustering
  vendor_phone_ocr text,           vendor_phone_verified text,       -- needed for clustering
  vendor_address_ocr text,         vendor_address_verified text,
  invoice_number_ocr text,         invoice_number_verified text,
  invoice_date_ocr date,           invoice_date_verified date,
  subtotal_ocr numeric(14,2),      subtotal_verified numeric(14,2),
  tax_amount_ocr numeric(14,2),    tax_amount_verified numeric(14,2),
  total_amount_ocr numeric(14,2),  total_amount_verified numeric(14,2),
  notes_ocr text,                  notes_verified text,

  verified_at timestamptz,
  verified_by uuid references auth.users(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index document_extraction_open_idx on public.document_extraction (created_at) where verified_at is null;
create index document_extraction_run_idx on public.document_extraction (current_extraction_run_id)
  where current_extraction_run_id is not null;
create index document_extraction_verified_by_idx on public.document_extraction (verified_by)
  where verified_by is not null;
-- source_document_id already has an index via its own `unique` constraint above.

-- The _ocr / _verified twin-column pattern is non-destructive by construction (§1, §9.2):
-- the OCR value is never overwritten, so the correction log (v_extraction_correction,
-- 20260808000028_reporting_views.sql) is a view rather than a new pipeline.
create trigger document_extraction_before_update
  before update on public.document_extraction
  for each row execute function private.set_updated_at();
