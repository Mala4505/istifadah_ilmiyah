-- v1 claimed "the audit trail never trusts a client-supplied value" while storing only
-- updated_by -- the LAST writer. An overwrite that records only its most recent author
-- is a silent overwrite. This table plus the trigger below fixes that (§3.9).
create table public.entry_change_log (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.entries(id) on delete cascade,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  source text not null check (source in ('import','manual','system')),
  changes jsonb not null                -- {field: {from: ..., to: ...}}
);
create index entry_change_log_entry_idx on public.entry_change_log (entry_id, changed_at desc);
create index entry_change_log_changed_by_idx on public.entry_change_log (changed_by)
  where changed_by is not null;

-- Written by a `before update` trigger that also forces updated_at = now() and
-- updated_by = auth.uid() server-side. Client-supplied audit values are never trusted.
--
-- JUDGEMENT CALL: the master plan describes the trigger's *responsibilities* (force
-- updated_at/updated_by, log a from/to diff) but not the exact diff mechanism. This
-- builds the diff generically from to_jsonb(old)/to_jsonb(new) rather than listing
-- columns by hand, so it stays correct if entries gains a column later. updated_at,
-- updated_by and created_at are excluded from the diff itself (they always change on
-- every update and would drown out the fields that actually matter); the *fact* that
-- they changed is already implicit in changed_at being written.
create or replace function private.log_entry_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_changes jsonb := '{}'::jsonb;
  v_key text;
  v_old_val jsonb;
  v_new_val jsonb;
  v_source text;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();

  -- Hub status changes get the same treatment, and matter most (§3.9): the one edit
  -- in this system that leaves the building. JUDGEMENT CALL: auto-stamp
  -- hub_status_changed_at/_by here on any change to hub_status_id, rather than relying
  -- on application code to remember to set them -- a missed application-layer set
  -- would silently corrupt the export/ageing story (§10.2 v_hub_status_ageing).
  if new.hub_status_id is distinct from old.hub_status_id then
    new.hub_status_changed_at := now();
    new.hub_status_changed_by := auth.uid();
  end if;

  for v_key in select jsonb_object_keys(v_new)
  loop
    if v_key in ('updated_at', 'updated_by', 'created_at') then
      continue;
    end if;
    v_old_val := v_old -> v_key;
    v_new_val := v_new -> v_key;
    if v_old_val is distinct from v_new_val then
      v_changes := v_changes || jsonb_build_object(v_key, jsonb_build_object('from', v_old_val, 'to', v_new_val));
    end if;
  end loop;

  if v_changes <> '{}'::jsonb then
    -- JUDGEMENT CALL: `source` isn't directly observable from inside a trigger. The
    -- importer's upsert (§3.6) deliberately excludes every Hub-owned column, so any
    -- write reaching this trigger without an authenticated user is treated as
    -- 'import'; everything else is an authenticated human action, 'manual'. Nothing in
    -- this schema currently issues a bare unauthenticated system write to entries, so
    -- 'system' is reserved for future use (e.g. a scheduled job) rather than produced here.
    v_source := case when auth.uid() is null then 'import' else 'manual' end;
    insert into public.entry_change_log (entry_id, changed_by, source, changes)
    values (new.id, auth.uid(), v_source, v_changes);
  end if;

  return new;
end;
$$;

create trigger entries_before_update
  before update on public.entries
  for each row execute function private.log_entry_change();

-- Generic "touch updated_at" trigger, reused by document_extraction (20260808000021)
-- and document_extraction_line_item (20260808000022) -- "the same trigger pattern
-- covers document_extraction and document_extraction_line_item" (§3.9). Those tables
-- have no updated_by column and are not entries, so they get the plain form rather
-- than the full change-log diff above.
create or replace function private.set_updated_at() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
