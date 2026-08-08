create table public.document_page (
  id bigint generated always as identity primary key,
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  page_number int not null,
  image_storage_path text,                -- NULLABLE and transient: the rasterised PNG is a derived
                                          -- artifact, held only while a run is in flight and cleared
                                          -- on success. Storing all of them triples storage (§6.2);
                                          -- pdf.js re-renders from the PDF for free on demand.
  is_financial_document boolean,          -- renamed: applies to invoices, chits, and receipts alike
  classification_confidence numeric(4,3),
  skip_reason text check (skip_reason in ('bank_cheque','passbook','unrelated_document','blank','other')),
  created_at timestamptz not null default now(),
  unique (source_document_id, page_number)
);
-- No separate FK index needed: the unique (source_document_id, page_number) constraint
-- above already gives a btree with source_document_id as its leading column.
