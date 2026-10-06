-- Item catalog editing is superadmin-only (user decision 2026-10-06), matching the
-- other structural /settings sub-routes. Re-creates the five RPCs from
-- 20261006120000_item_catalog_confirmation.sql with the role check switched from
-- private.is_admin_or_above() to private.is_superadmin(); bodies otherwise unchanged.
-- `create or replace` keeps the existing EXECUTE grants (authenticated only).

create or replace function public.set_item_catalog_confirmed(
  p_item_ids bigint[],
  p_confirmed boolean
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if not (select private.is_superadmin()) then
    raise exception 'Confirming catalog items is a superadmin action.';
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
  if not (select private.is_superadmin()) then
    raise exception 'Moving catalog items is a superadmin action.';
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
  if not (select private.is_superadmin()) then
    raise exception 'Merging catalog items is a superadmin action.';
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
  if not (select private.is_superadmin()) then
    raise exception 'Assigning bill lines to the catalog is a superadmin action.';
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
  if not (select private.is_superadmin()) then
    raise exception 'Creating catalog items is a superadmin action.';
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
