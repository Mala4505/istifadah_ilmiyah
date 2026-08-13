-- Phase 2 (§14, §18) -- item catalog and item_key normalization.
--
-- MASTER-PLAN §3.10 specifies a single flat `item_key` on rate_reference. Reading the
-- real corpus (21 venue-setup invoices, 2026-08-12) showed that a flat key cannot work:
-- line descriptions are hyper-specific to the point of being unique per invoice --
--
--     "8" x 10kg boring PVC pipe 80ft"
--     "8" x 10kg boring PVC filter pipe 40ft"
--     "Jeet 5 hp 7 stage 2500 RPM 3ph DOL submersible motor pump set"
--
-- Every one of those normalises to its own key, so cross-vendor comparison -- the entire
-- point of the exercise -- returns zero matches. Two levels fix it without changing what
-- rate_reference already accumulates:
--
--   item_family  coarse, the level rates are actually comparable ACROSS vendors
--                ('pvc-boring-pipe', 'gypsum-ceiling'), carries the unit
--   item_catalog exact spec, the level rates are comparable WITHIN a vendor over time
--                ('pvc-boring-pipe-8in-10kg')
--
-- Confirmed with the user 2026-08-12 before writing.
--
-- The resolution rule deliberately mirrors vendor/vendor_alias (20260808000008): normalize
-- -> exact match on an alias -> attach; no match -> create an UNCONFIRMED row and record
-- the alias. Never fuzzy-auto-merge. Merging two items silently rewrites every rate
-- benchmark computed from them, which is the same class of irreversible-by-inference
-- mistake that merging two vendors is, and it stays a human decision for the same reason.

-- ----------------------------------------------------------------------------
-- item_family -- the cross-vendor comparable level.
-- ----------------------------------------------------------------------------
create table public.item_family (
  id bigint generated always as identity primary key,
  family_key text not null unique,        -- slug: 'gypsum-ceiling', 'pvc-boring-pipe'
  label text not null,
  default_unit text,                      -- sqft/nos/ft/m/day -- the unit rates compare in
  -- Families whose members are inherently one-off (labour LS, transport, "gravel solvent
  -- and sand LS") are marked here rather than per-item, because the property belongs to
  -- the kind of thing, not the individual line.
  is_comparable boolean not null default true,
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index item_family_unconfirmed_idx on public.item_family (created_at)
  where is_confirmed = false;
create index item_family_trgm_idx on public.item_family using gin (label extensions.gin_trgm_ops);

create trigger item_family_before_update
  before update on public.item_family
  for each row execute function private.set_updated_at();

-- ----------------------------------------------------------------------------
-- item_catalog -- the exact-spec level.
-- ----------------------------------------------------------------------------
create table public.item_catalog (
  id bigint generated always as identity primary key,
  item_family_id bigint references public.item_family(id),
  item_key text not null unique,
  canonical_label text not null,
  -- Structured spec extracted from the description: {"diameter_in": 8, "weight_kg": 10,
  -- "length_ft": 80}. Kept as jsonb rather than columns because the dimensions that matter
  -- differ per family (pipe has diameter, ceiling has thickness, pump has horsepower) and
  -- inventing a column per dimension would produce a table that is mostly nulls.
  spec jsonb not null default '{}'::jsonb,
  unit_normalized text,
  -- Overrides the family default. A single LS line inside an otherwise comparable family
  -- (e.g. "boring pump and electrical fitting labour charges LS" inside 'boring-works')
  -- is excluded here without excluding the family.
  is_comparable boolean not null default true,
  is_confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index item_catalog_family_idx on public.item_catalog (item_family_id)
  where item_family_id is not null;
create index item_catalog_unconfirmed_idx on public.item_catalog (created_at)
  where is_confirmed = false;
create index item_catalog_trgm_idx on public.item_catalog
  using gin (canonical_label extensions.gin_trgm_ops);

create trigger item_catalog_before_update
  before update on public.item_catalog
  for each row execute function private.set_updated_at();

-- ----------------------------------------------------------------------------
-- item_alias -- every raw description ever seen, mapped to a catalog entry.
-- ----------------------------------------------------------------------------
-- Directly parallel to vendor_alias. `normalized_description` is unique so the same raw
-- text can never resolve two ways; re-running the proposer is therefore idempotent.
create table public.item_alias (
  id bigint generated always as identity primary key,
  item_catalog_id bigint not null references public.item_catalog(id) on delete cascade,
  raw_description text not null,
  normalized_description text not null unique,
  source text not null check (source in ('llm','manual','import')),
  -- Only meaningful for source = 'llm'. A low-confidence proposal still creates the row
  -- (so the description is never silently dropped) but surfaces first in the confirm queue.
  confidence numeric(4,3),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index item_alias_catalog_idx on public.item_alias (item_catalog_id);
create index item_alias_unconfirmed_idx on public.item_alias (confidence asc nulls last)
  where confirmed_at is null;
create index item_alias_confirmed_by_idx on public.item_alias (confirmed_by)
  where confirmed_by is not null;

-- ----------------------------------------------------------------------------
-- rate_reference -- back-fillable additions.
-- ----------------------------------------------------------------------------
-- item_key stays exactly as §3.10 defined it (text, nullable, keyed retroactively). These
-- columns are additive: rows already accumulated since Phase 1B day 4 keep working and get
-- their family assigned by the same back-fill pass that assigns item_key.
alter table public.rate_reference
  add column item_family_id bigint references public.item_family(id),
  add column item_catalog_id bigint references public.item_catalog(id),
  -- Denormalised from item_catalog/item_family at write time. A lump-sum line must be
  -- excluded from every rate statistic, and making that a join through two tables means
  -- every benchmark query has to remember to do it. One boolean on the fact row means the
  -- partial indexes below can exclude them outright.
  add column is_comparable boolean not null default true,
  -- Rates are compared pre-tax. Where a vendor charges no GST at all (four of eight vendors
  -- in the pilot corpus) their net_rate is not like-for-like against a GST-charging vendor's,
  -- and the benchmark needs to say so rather than quietly rank them together.
  add column gst_rate numeric(5,2),
  add column quantity numeric(12,3);

create index rate_reference_family_idx
  on public.rate_reference (item_family_id, unit_normalized, observed_date desc)
  where is_comparable = true;
create index rate_reference_catalog_idx
  on public.rate_reference (item_catalog_id, observed_date desc)
  where is_comparable = true;

-- ----------------------------------------------------------------------------
-- RLS -- same shape as vendor / vendor_alias in 20260808000026.
-- ----------------------------------------------------------------------------
-- Catalog rows carry no department_id: an item is an item regardless of which department
-- bought it, and the whole point of the catalog is comparison ACROSS departments. Scoping
-- is therefore is_staff() only, exactly as vendor_select is.
--
-- Confirming a proposed item is a review action, not an admin one -- it is the same
-- judgement a reviewer already makes on every extraction (§7), so it carries the same
-- is_reviewer_or_admin() gate. Merging two confirmed items is the destructive operation
-- (it rewrites history for every benchmark built on them) and is deliberately NOT
-- reachable through these policies; it lands later as an admin-only RPC, mirroring how
-- vendor merges are handled.
alter table public.item_family enable row level security;
alter table public.item_catalog enable row level security;
alter table public.item_alias enable row level security;

create policy item_family_select on public.item_family for select to authenticated
  using ((select private.is_staff()));
create policy item_family_update_reviewer on public.item_family for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

create policy item_catalog_select on public.item_catalog for select to authenticated
  using ((select private.is_staff()));
create policy item_catalog_update_reviewer on public.item_catalog for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));

create policy item_alias_select on public.item_alias for select to authenticated
  using ((select private.is_staff()));
create policy item_alias_update_reviewer on public.item_alias for update to authenticated
  using ((select private.is_reviewer_or_admin()))
  with check ((select private.is_reviewer_or_admin()));
-- No insert policy on any of the three: rows are created by the extraction/back-fill
-- pipeline running as service_role. Deny-by-default for authenticated, as with vendor_alias.

grant select on public.item_family, public.item_catalog, public.item_alias to authenticated;
grant update on public.item_family, public.item_catalog, public.item_alias to authenticated;
