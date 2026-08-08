create table public.document_extraction_line_item (
  id bigint generated always as identity primary key,
  document_extraction_id bigint not null references public.document_extraction(id) on delete cascade,
  document_page_id bigint references public.document_page(id),
  line_order int not null,

  description_ocr text,           description_verified text,
  hsn_sac_code_ocr text,          hsn_sac_code_verified text,
  quantity_ocr numeric(12,3),     quantity_verified numeric(12,3),
  quantity_raw_text_ocr text,     quantity_raw_text_verified text,   -- e.g. "19+12+7+5+7+5"
  unit_ocr text,                  unit_verified text,
  unit_normalized text,                                              -- sqft/nos/day — set on verify
  list_rate_ocr numeric(14,2),    list_rate_verified numeric(14,2),
  discount_pct_ocr numeric(6,3),  discount_pct_verified numeric(6,3),
  discount_note_ocr text,         discount_note_verified text,
  net_rate_ocr numeric(14,2),     net_rate_verified numeric(14,2),
  line_amount_ocr numeric(14,2),  line_amount_verified numeric(14,2),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_line_item_parent_idx on public.document_extraction_line_item (document_extraction_id);
create index doc_line_item_page_idx on public.document_extraction_line_item (document_page_id)
  where document_page_id is not null;

-- unit_normalized is a small controlled vocabulary picked from a dropdown at verify
-- time (§3.8) -- comparing a rate in 'sq ft' against 'sqft' against 'running feet'
-- produces confident nonsense, and normalising after the fact is far harder than at
-- the point a human is already looking at the line.
create trigger document_extraction_line_item_before_update
  before update on public.document_extraction_line_item
  for each row execute function private.set_updated_at();
