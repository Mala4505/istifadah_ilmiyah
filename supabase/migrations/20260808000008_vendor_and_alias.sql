create table public.vendor (
  id bigint generated always as identity primary key,
  display_name text not null,
  normalized_name text not null unique,  -- lower, punctuation/whitespace stripped, legal suffixes removed
  gstin text,
  phone text,
  address text,
  bank_account_last4 text,
  cluster_group_id bigint references public.vendor(id),  -- self-ref; null = not clustered
  is_confirmed boolean not null default false,           -- true once a human has reviewed the identity
  created_at timestamptz not null default now()
);
create index vendor_gstin_idx on public.vendor (gstin) where gstin is not null;
create index vendor_phone_idx on public.vendor (phone) where phone is not null;
create index vendor_cluster_idx on public.vendor (cluster_group_id) where cluster_group_id is not null;

-- pg_trgm is created in 20260808000001_extensions.sql.
create index vendor_trgm_idx on public.vendor using gin (normalized_name gin_trgm_ops);

create table public.vendor_alias (
  id bigint generated always as identity primary key,
  vendor_id bigint not null references public.vendor(id) on delete cascade,
  raw_name text not null unique,
  source text not null check (source in ('import','ocr','manual')),
  created_at timestamptz not null default now()
);
create index vendor_alias_vendor_idx on public.vendor_alias (vendor_id);

-- Resolution rule (import + OCR verify): normalize -> exact match on normalized_name or
-- vendor_alias.raw_name -> attach. No match -> create a new vendor with is_confirmed =
-- false and record the alias. Never fuzzy-auto-merge (§3.2) -- merging affects payment
-- routing and stays a human decision; vendor.cluster_group_id / vendor_alias.source =
-- 'manual' are exactly how that human decision is recorded.
