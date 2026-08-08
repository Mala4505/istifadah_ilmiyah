-- Populated from day 4 even though nothing queries it until week 2. Without this,
-- week 2 starts with zero history and the rate reports are empty (§3.10).
create table public.rate_reference (
  id bigint generated always as identity primary key,
  item_key text,                         -- null until the item catalog lands in week 2
  item_description_raw text not null,
  vendor_id bigint not null references public.vendor(id),
  net_rate numeric(14,2) not null,
  unit_normalized text,
  discount_pct numeric(6,3),
  observed_date date,
  entry_id bigint references public.entries(id),
  line_item_id bigint references public.document_extraction_line_item(id),
  created_at timestamptz not null default now()
);
create index rate_reference_item_vendor_idx on public.rate_reference (item_key, vendor_id);
create index rate_reference_item_date_idx on public.rate_reference (item_key, observed_date desc);
-- supplementary: vendor_id is not null but only appears as the trailing column above,
-- so a lookup by vendor alone (independent of item_key) needs its own index (§3 preamble).
create index rate_reference_vendor_idx on public.rate_reference (vendor_id);
create index rate_reference_entry_idx on public.rate_reference (entry_id) where entry_id is not null;
create index rate_reference_line_item_idx on public.rate_reference (line_item_id) where line_item_id is not null;
