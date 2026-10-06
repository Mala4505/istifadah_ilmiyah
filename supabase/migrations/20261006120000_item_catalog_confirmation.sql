-- Item catalog human confirmation (MASTER-PLAN Phase 2 / docs/report-data-gaps-plan.md
-- Phase 2 follow-up). 20261005084229_item_families.sql auto-mapped every rate_reference
-- line onto item_family / item_catalog via exact item_alias matches, all UNCONFIRMED.
-- This migration backs the /settings/item-catalog screen where an admin confirms or
-- corrects those mappings:
--
--   confirm      item_catalog.is_confirmed + confirmed_at/confirmed_by (new columns);
--                the item's aliases are stamped confirmed in the same statement
--   rename       plain UPDATE of canonical_label (existing item_catalog_update_reviewer)
--   move family  repoints the item and every rate_reference row on it
--   merge        folds one catalog item into another: aliases + rate_reference rows
--                move, the source row is deleted
--   assign       attaches a raw description (unmatched, or a low-confidence match) to a
--                catalog item: upserts a manual, confirmed item_alias and repoints every
--                rate_reference row with that normalised description
--   create       a new catalog item inside an existing family, for an unmatched line
--                that fits no existing item
--
-- rate_reference has no write policy for `authenticated` (20260808000026) and
-- item_catalog / item_alias have no insert/delete policy (20260814000001), so every
-- multi-table mutation is a SECURITY DEFINER RPC gated on private.is_admin_or_above()
-- (the same floor as is_reviewer_or_admin since 20260819000003). Nothing here is fuzzy:
-- every write is a human decision on an exact normalised description.

-- ----------------------------------------------------------------------------
-- 1. confirmation audit columns
-- ----------------------------------------------------------------------------
alter table public.item_catalog
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references auth.users(id);

-- FK index (confirmed_by), partial because almost every row starts null.
create index if not exists item_catalog_confirmed_by_idx
  on public.item_catalog (confirmed_by)
  where confirmed_by is not null;

-- Rows somebody already confirmed before these columns existed keep their flag; stamp a
-- best-known time so "confirmed" always carries a confirmed_at.
update public.item_catalog
   set confirmed_at = updated_at
 where is_confirmed and confirmed_at is null;

-- ----------------------------------------------------------------------------
-- 2. indexes the screen and the RPCs lean on
-- ----------------------------------------------------------------------------
-- Every FK on rate_reference.item_catalog_id gets a plain index: line counts per item,
-- merge/move repoints, and the `item_catalog_id is null` unmatched scan. The existing
-- rate_reference_catalog_idx is partial (is_comparable = true) and cannot serve these.
create index if not exists rate_reference_item_catalog_id_idx
  on public.rate_reference (item_catalog_id);

-- Assign repoints rate_reference rows by normalised description; the same expression the
-- rate_reference_assign_item trigger matches on, so the planner can use it verbatim.
create index if not exists rate_reference_item_description_norm_idx
  on public.rate_reference (private.normalize_item_description(item_description_raw));

-- ----------------------------------------------------------------------------
-- 3. read views (security_invoker -- base-table RLS applies: is_staff() on all four)
-- ----------------------------------------------------------------------------
create or replace view public.v_item_catalog_review with (security_invoker = true) as
select
  ic.id,
  ic.item_key,
  ic.canonical_label,
  ic.spec,
  ic.unit_normalized,
  ic.is_comparable,
  ic.is_confirmed,
  ic.confirmed_at,
  ic.confirmed_by,
  ic.item_family_id,
  f.family_key,
  f.label as family_label,
  f.category,
  coalesce(rr.line_count, 0)::int as line_count,
  coalesce(rr.vendor_count, 0)::int as vendor_count,
  rr.pretax_value,
  rr.last_seen,
  coalesce(al.alias_count, 0)::int as alias_count,
  coalesce(al.unconfirmed_alias_count, 0)::int as unconfirmed_alias_count,
  coalesce(al.sample_descriptions, '{}'::text[]) as sample_descriptions
from public.item_catalog ic
left join public.item_family f on f.id = ic.item_family_id
left join lateral (
  select
    count(*) as line_count,
    count(distinct r.vendor_id) as vendor_count,
    sum(r.net_rate * r.quantity) as pretax_value,
    max(r.observed_date) as last_seen
  from public.rate_reference r
  where r.item_catalog_id = ic.id
) rr on true
left join lateral (
  select
    count(*) as alias_count,
    count(*) filter (where a.confirmed_at is null) as unconfirmed_alias_count,
    (array_agg(a.raw_description order by length(a.raw_description), a.raw_description))[1:3]
      as sample_descriptions
  from public.item_alias a
  where a.item_catalog_id = ic.id
) al on true;

comment on view public.v_item_catalog_review is
  'One row per item_catalog entry with its family, line/vendor counts, pre-tax value and up to 3 sample descriptions -- /settings/item-catalog.';

-- Lines a human should assign:
--   unmatched     rate_reference rows the alias trigger could not attach (no alias)
--   size_not_read an unconfirmed alias that landed on a family's bare (spec = {}) item
--                 while the family has sized siblings -- the rules could not read a size
--   low_confidence an unconfirmed LLM-proposed alias below 0.7 confidence
create or replace view public.v_item_lines_to_assign with (security_invoker = true) as
with unmatched as (
  select
    private.normalize_item_description(r.item_description_raw) as normalized_description,
    min(r.item_description_raw) as raw_description,
    count(*)::int as line_count,
    count(distinct r.vendor_id)::int as vendor_count,
    sum(r.net_rate * r.quantity) as pretax_value,
    max(r.observed_date) as last_seen,
    min(r.unit_normalized) as unit_normalized
  from public.rate_reference r
  where r.item_catalog_id is null
  group by 1
),
suspect_alias as (
  select
    a.id as alias_id,
    a.normalized_description,
    a.raw_description,
    a.confidence,
    ic.id as item_catalog_id,
    ic.canonical_label,
    f.label as family_label,
    case
      when a.source = 'llm' and a.confidence is not null and a.confidence < 0.7 then 'low_confidence'
      else 'size_not_read'
    end as reason
  from public.item_alias a
  join public.item_catalog ic on ic.id = a.item_catalog_id
  left join public.item_family f on f.id = ic.item_family_id
  where a.confirmed_at is null
    and (
      (a.source = 'llm' and a.confidence is not null and a.confidence < 0.7)
      or (
        ic.spec = '{}'::jsonb
        and ic.item_family_id is not null
        and exists (
          select 1 from public.item_catalog sib
          where sib.item_family_id = ic.item_family_id
            and sib.id <> ic.id
            and sib.spec <> '{}'::jsonb
        )
      )
    )
)
select
  'unmatched'::text as reason,
  u.normalized_description,
  u.raw_description,
  null::bigint as alias_id,
  null::numeric as confidence,
  null::bigint as item_catalog_id,
  null::text as canonical_label,
  null::text as family_label,
  u.line_count,
  u.vendor_count,
  u.pretax_value,
  u.last_seen,
  u.unit_normalized
from unmatched u
where u.normalized_description <> ''
union all
select
  s.reason,
  s.normalized_description,
  s.raw_description,
  s.alias_id,
  s.confidence,
  s.item_catalog_id,
  s.canonical_label,
  s.family_label,
  coalesce(l.line_count, 0)::int,
  coalesce(l.vendor_count, 0)::int,
  l.pretax_value,
  l.last_seen,
  l.unit_normalized
from suspect_alias s
left join lateral (
  select
    count(*) as line_count,
    count(distinct r.vendor_id) as vendor_count,
    sum(r.net_rate * r.quantity) as pretax_value,
    max(r.observed_date) as last_seen,
    min(r.unit_normalized) as unit_normalized
  from public.rate_reference r
  where private.normalize_item_description(r.item_description_raw) = s.normalized_description
) l on true;

comment on view public.v_item_lines_to_assign is
  'Bill-line descriptions needing a human catalog decision: unmatched, size not read, or low-confidence LLM alias -- /settings/item-catalog.';

grant select on public.v_item_catalog_review, public.v_item_lines_to_assign to authenticated;

-- ----------------------------------------------------------------------------
-- 4. RPCs
-- ----------------------------------------------------------------------------

-- Confirm / un-confirm a set of catalog items in one statement. Confirming also stamps
-- the item's still-unconfirmed aliases, so they drop out of the to-assign queue.
create or replace function public.set_item_catalog_confirmed(
  p_item_ids bigint[],
  p_confirmed boolean
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Confirming catalog items is an admin action.';
  end if;

  update public.item_catalog ic
     set is_confirmed = p_confirmed,
         confirmed_at = case when p_confirmed then now() else null end,
         confirmed_by = case when p_confirmed then (select auth.uid()) else null end
   where ic.id = any(p_item_ids)
     and ic.is_confirmed is distinct from p_confirmed;
  get diagnostics v_count = row_count;

  if p_confirmed then
    update public.item_alias a
       set confirmed_at = now(),
           confirmed_by = (select auth.uid())
     where a.item_catalog_id = any(p_item_ids)
       and a.confirmed_at is null;
  end if;

  return v_count;
end;
$$;

-- Move a catalog item (and every rate_reference line on it) to another family.
create or replace function public.move_item_catalog_family(
  p_item_id bigint,
  p_family_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Moving catalog items is an admin action.';
  end if;
  if not exists (select 1 from public.item_family f where f.id = p_family_id) then
    raise exception 'That family no longer exists.';
  end if;

  update public.item_catalog
     set item_family_id = p_family_id
   where id = p_item_id;
  if not found then
    raise exception 'That catalog item no longer exists.';
  end if;

  update public.rate_reference
     set item_family_id = p_family_id
   where item_catalog_id = p_item_id
     and item_family_id is distinct from p_family_id;
end;
$$;

-- Fold p_source_id into p_target_id: aliases and rate_reference lines move to the target
-- (taking the target's family and comparability), then the source row is deleted.
-- Irreversible except by re-assigning the moved descriptions, hence admin-only and
-- confirmed in the UI first.
create or replace function public.merge_item_catalog(
  p_source_id bigint,
  p_target_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_target public.item_catalog%rowtype;
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Merging catalog items is an admin action.';
  end if;
  if p_source_id = p_target_id then
    raise exception 'A catalog item cannot be merged into itself.';
  end if;

  -- Lock both rows in id order so two concurrent merges cannot deadlock.
  perform 1 from public.item_catalog
   where id in (p_source_id, p_target_id)
   order by id
   for update;

  select * into v_target from public.item_catalog where id = p_target_id;
  if not found then
    raise exception 'The item to merge into no longer exists.';
  end if;
  if not exists (select 1 from public.item_catalog where id = p_source_id) then
    raise exception 'The item being merged no longer exists.';
  end if;

  update public.item_alias
     set item_catalog_id = p_target_id
   where item_catalog_id = p_source_id;

  update public.rate_reference
     set item_catalog_id = p_target_id,
         item_family_id = v_target.item_family_id,
         is_comparable = v_target.is_comparable
   where item_catalog_id = p_source_id;

  delete from public.item_catalog where id = p_source_id;
end;
$$;

-- Attach a raw description to a catalog item: a manual, confirmed alias (replacing any
-- existing alias for the same normalised text) and every matching rate_reference line.
-- Returns the number of rate_reference lines repointed.
create or replace function public.assign_item_description(
  p_raw_description text,
  p_item_id bigint
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_norm text := private.normalize_item_description(p_raw_description);
  v_item public.item_catalog%rowtype;
  v_count integer;
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Assigning bill lines to the catalog is an admin action.';
  end if;
  if v_norm = '' then
    raise exception 'That description is empty.';
  end if;

  select * into v_item from public.item_catalog where id = p_item_id;
  if not found then
    raise exception 'That catalog item no longer exists.';
  end if;

  insert into public.item_alias
    (item_catalog_id, raw_description, normalized_description, source, confidence, confirmed_by, confirmed_at)
  values
    (p_item_id, p_raw_description, v_norm, 'manual', null, (select auth.uid()), now())
  on conflict (normalized_description) do update
     set item_catalog_id = excluded.item_catalog_id,
         source = 'manual',
         confidence = null,
         confirmed_by = excluded.confirmed_by,
         confirmed_at = excluded.confirmed_at;

  update public.rate_reference
     set item_catalog_id = v_item.id,
         item_family_id = v_item.item_family_id,
         is_comparable = v_item.is_comparable
   where private.normalize_item_description(item_description_raw) = v_norm;
  get diagnostics v_count = row_count;

  return v_count;
end;
$$;

-- Create a new (confirmed) catalog item inside an existing family. item_key is built
-- from the family key plus a slug of the label; a numeric suffix keeps it unique.
create or replace function public.create_item_catalog(
  p_family_id bigint,
  p_label text
) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_family public.item_family%rowtype;
  v_label text := btrim(coalesce(p_label, ''));
  v_slug text;
  v_key text;
  v_n integer := 1;
  v_id bigint;
begin
  if not (select private.is_admin_or_above()) then
    raise exception 'Creating catalog items is an admin action.';
  end if;
  if v_label = '' then
    raise exception 'Give the new item a name.';
  end if;

  select * into v_family from public.item_family where id = p_family_id;
  if not found then
    raise exception 'That family no longer exists.';
  end if;

  v_slug := btrim(regexp_replace(lower(v_label), '[^a-z0-9.]+', '-', 'g'), '-');
  v_key := v_family.family_key || case when v_slug = '' then '' else '-' || v_slug end;
  while exists (select 1 from public.item_catalog where item_key = v_key) loop
    v_n := v_n + 1;
    v_key := v_family.family_key || case when v_slug = '' then '' else '-' || v_slug end || '-' || v_n;
  end loop;

  insert into public.item_catalog
    (item_family_id, item_key, canonical_label, spec, unit_normalized, is_comparable,
     is_confirmed, confirmed_at, confirmed_by)
  values
    (v_family.id, v_key, v_label, '{}'::jsonb, v_family.default_unit, v_family.is_comparable,
     true, now(), (select auth.uid()))
  returning id into v_id;

  return v_id;
end;
$$;

-- Supabase grants EXECUTE on new public functions to anon by default; revoke explicitly
-- (20260814000004) and re-grant to authenticated only. Each body re-checks the role.
revoke all on function public.set_item_catalog_confirmed(bigint[], boolean) from public, anon, authenticated;
revoke all on function public.move_item_catalog_family(bigint, bigint) from public, anon, authenticated;
revoke all on function public.merge_item_catalog(bigint, bigint) from public, anon, authenticated;
revoke all on function public.assign_item_description(text, bigint) from public, anon, authenticated;
revoke all on function public.create_item_catalog(bigint, text) from public, anon, authenticated;

grant execute on function public.set_item_catalog_confirmed(bigint[], boolean) to authenticated;
grant execute on function public.move_item_catalog_family(bigint, bigint) to authenticated;
grant execute on function public.merge_item_catalog(bigint, bigint) to authenticated;
grant execute on function public.assign_item_description(text, bigint) to authenticated;
grant execute on function public.create_item_catalog(bigint, text) to authenticated;
