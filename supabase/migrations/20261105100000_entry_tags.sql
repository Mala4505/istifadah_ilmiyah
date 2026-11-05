-- Entry tags, Phase 1: schema. Plan: docs/entry-tags-plan.md.
--
-- A tag is a named record of something an event's spending left behind (a washroom
-- block, tent stock, equipment). It belongs to one or more departments (optionally
-- sub-departments), may be linked to the entries that paid for it, and shows in every
-- event from its start event to its end event (null end = perpetual).
--
--   tag             the record itself
--   tag_entry       tag <-> entries link (optional; a tag can have no entries)
--   tag_scope       departments / department+sub-department on the tag
--   tag_event_note  at most one free-text note per tag per event
--
-- Decision 1: NO column on public.entries -- the Excel import can never overwrite tags.
--
-- Behaviour:
--   * tag_entry insert  -> upsert tag_scope (entry's department + sub-department, if
--                          the entry has a department), and move tag.start_event_id
--                          back when the entry's event is earlier.
--   * entries update    -> when sub_department_id changes to a value, upsert the
--                          matching tag_scope row for every linked tag.
--   * tag_entry delete  -> removes nothing from tag_scope (decision 8).
--   * end_event_id, when set, may not be before start_event_id.
--   * the last department row of an existing tag cannot be deleted (decision 3).
--
-- Event order: by event.starts_on when both events have one and they differ,
-- otherwise by hijri_year (shorter string first, then text order, so '999' < '1448').
--
-- RLS: writes are superadmin-only on all four tables. Reads: admin-or-above see all
-- (an admin can see every department -- private.can_see_department semantics); a
-- `dept` user sees a tag only when one of its tag_scope departments is theirs.
-- Set-based form as in 20261005120000: the visible tag ids are computed ONCE per
-- statement (uncorrelated InitPlan), never one helper call per row.
--
-- Staging: run the same SQL with `public.` -> `staging.` and `private.` ->
-- `staging_private.` (docs/staging.md).

-- ============================================================================
-- 1. Tables
-- ============================================================================

create table public.tag (
  id             bigint generated always as identity primary key,
  name           text not null check (btrim(name) <> ''),
  description    text,
  start_event_id bigint not null references public.event(id),
  end_event_id   bigint references public.event(id),        -- null = perpetual
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);

create table public.tag_entry (
  tag_id    bigint not null references public.tag(id) on delete cascade,
  entry_id  bigint not null references public.entries(id),
  linked_at timestamptz not null default now(),
  linked_by uuid references auth.users(id),
  primary key (tag_id, entry_id)
);

create table public.tag_scope (
  id                bigint generated always as identity primary key,
  tag_id            bigint not null references public.tag(id) on delete cascade,
  department_id     bigint not null references public.department(id),
  sub_department_id bigint references public.sub_department(id),
  source            text not null default 'manual' check (source in ('entry', 'manual')),
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),
  constraint tag_scope_tag_department_sub_department_key
    unique nulls not distinct (tag_id, department_id, sub_department_id)
);

create table public.tag_event_note (
  tag_id     bigint not null references public.tag(id) on delete cascade,
  event_id   bigint not null references public.event(id),
  note       text not null check (btrim(note) <> ''),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (tag_id, event_id)
);

-- ============================================================================
-- 2. Indexes (every FK; tag_scope(tag_id, ...) and the two PKs lead with tag_id)
-- ============================================================================

create index tag_entry_entry_id_idx          on public.tag_entry (entry_id);
create index tag_scope_department_id_idx     on public.tag_scope (department_id);
create index tag_scope_sub_department_id_idx on public.tag_scope (sub_department_id)
  where sub_department_id is not null;
create index tag_start_event_id_idx          on public.tag (start_event_id);
create index tag_end_event_id_idx            on public.tag (end_event_id)
  where end_event_id is not null;
create index tag_event_note_event_id_idx     on public.tag_event_note (event_id);

-- ============================================================================
-- 3. Helpers
-- ============================================================================

-- True when event a is strictly before event b (see "Event order" above).
-- Only called from the security-definer trigger functions below.
create or replace function private.event_precedes(a bigint, b bigint) returns boolean
language sql stable set search_path = '' as $$
  select case
    when ea.starts_on is not null and eb.starts_on is not null and ea.starts_on <> eb.starts_on
      then ea.starts_on < eb.starts_on
    else (length(ea.hijri_year), ea.hijri_year) < (length(eb.hijri_year), eb.hijri_year)
  end
  from public.event ea, public.event eb
  where ea.id = a and eb.id = b
$$;

-- Set form of "tags this user may read": computed once per statement. Only the
-- dept-user branch of the policies uses it (admin-or-above short-circuits first).
create or replace function private.visible_tag_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct ts.tag_id), '{}'::bigint[])
  from public.tag_scope ts
  where ts.department_id = any (private.my_department_ids())
$$;

revoke all on function private.event_precedes(bigint, bigint) from public, anon, authenticated;
revoke all on function private.visible_tag_ids() from public, anon;
grant execute on function private.visible_tag_ids() to authenticated;

-- ============================================================================
-- 4. Triggers
-- ============================================================================

-- 4a. Audit stamps -- server-side, so a caller cannot forge who/when.
create or replace function private.tag_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := (select auth.uid());
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create or replace function private.tag_entry_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.linked_at := now();
  new.linked_by := (select auth.uid());
  return new;
end;
$$;

create or replace function private.tag_scope_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_at := now();
  new.created_by := (select auth.uid());
  return new;
end;
$$;

create or replace function private.tag_event_note_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create trigger tag_stamp before insert or update on public.tag
  for each row execute function private.tag_stamp();
create trigger tag_entry_stamp before insert on public.tag_entry
  for each row execute function private.tag_entry_stamp();
create trigger tag_scope_stamp before insert on public.tag_scope
  for each row execute function private.tag_scope_stamp();
create trigger tag_event_note_stamp before insert or update on public.tag_event_note
  for each row execute function private.tag_event_note_stamp();

-- 4b. Check: end event, when set, is not before the start event. A CHECK constraint
-- cannot read public.event, so this is a trigger (errcode check_violation).
create or replace function private.tag_check_period() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.end_event_id is not null
     and new.end_event_id <> new.start_event_id
     and private.event_precedes(new.end_event_id, new.start_event_id) then
    raise exception 'A tag''s end event cannot be before its start event'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tag_check_period before insert or update of start_event_id, end_event_id
  on public.tag
  for each row execute function private.tag_check_period();

-- 4c. Linking an entry: add its department (+ sub-department) to the tag, and move
-- the start event back when the entry is older. An entry with no department adds
-- no scope; an entry with no sub-department adds a department-only row. Never errors
-- on a missing sub-department (decision 4).
create or replace function private.tag_entry_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_department_id     bigint;
  v_sub_department_id bigint;
  v_event_id          bigint;
  v_start_event_id    bigint;
begin
  select e.department_id, e.sub_department_id, e.event_id
    into v_department_id, v_sub_department_id, v_event_id
  from public.entries e
  where e.id = new.entry_id;

  if v_department_id is not null then
    insert into public.tag_scope (tag_id, department_id, sub_department_id, source)
    values (new.tag_id, v_department_id, v_sub_department_id, 'entry')
    on conflict on constraint tag_scope_tag_department_sub_department_key do nothing;
  end if;

  select t.start_event_id into v_start_event_id from public.tag t where t.id = new.tag_id;
  if v_event_id is not null
     and v_event_id <> v_start_event_id
     and private.event_precedes(v_event_id, v_start_event_id) then
    update public.tag set start_event_id = v_event_id where id = new.tag_id;
  end if;

  return null;
end;
$$;

create trigger tag_entry_after_insert after insert on public.tag_entry
  for each row execute function private.tag_entry_after_insert();

-- 4d. A linked entry's sub-department set (or changed) later: add the matching scope
-- row to every tag the entry is on. Never removes scope rows (decision 8). Fires on
-- any update (not `update of sub_department_id`) because the BEFORE trigger
-- private.fill_entry_sub_department can set the column without it being in SET.
create or replace function private.entries_tag_scope_from_sub_department() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tag_scope (tag_id, department_id, sub_department_id, source)
  select te.tag_id, new.department_id, new.sub_department_id, 'entry'
  from public.tag_entry te
  where te.entry_id = new.id
  on conflict on constraint tag_scope_tag_department_sub_department_key do nothing;
  return null;
end;
$$;

create trigger entries_tag_scope_from_sub_department after update on public.entries
  for each row
  when (new.sub_department_id is not null
        and new.department_id is not null
        and new.sub_department_id is distinct from old.sub_department_id)
  execute function private.entries_tag_scope_from_sub_department();

-- 4e. A tag keeps at least one department (decision 3): the last scope row of a tag
-- that still exists cannot be deleted. Deleting the tag itself cascades normally
-- (the parent row is already gone when the cascade runs).
create or replace function private.tag_scope_keep_one() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.tag t where t.id = old.tag_id)
     and not exists (
       select 1 from public.tag_scope ts where ts.tag_id = old.tag_id and ts.id <> old.id
     ) then
    raise exception 'A tag must keep at least one department'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;

create trigger tag_scope_keep_one before delete on public.tag_scope
  for each row execute function private.tag_scope_keep_one();

revoke all on function private.tag_stamp()                             from public, anon, authenticated;
revoke all on function private.tag_entry_stamp()                       from public, anon, authenticated;
revoke all on function private.tag_scope_stamp()                       from public, anon, authenticated;
revoke all on function private.tag_event_note_stamp()                  from public, anon, authenticated;
revoke all on function private.tag_check_period()                      from public, anon, authenticated;
revoke all on function private.tag_entry_after_insert()                from public, anon, authenticated;
revoke all on function private.entries_tag_scope_from_sub_department() from public, anon, authenticated;
revoke all on function private.tag_scope_keep_one()                    from public, anon, authenticated;

-- ============================================================================
-- 5. RLS
--    READ(t)  := (select private.is_admin_or_above())
--                or t = any ((select private.visible_tag_ids())::bigint[])
--    WRITE    := (select private.is_superadmin())
-- ============================================================================

alter table public.tag            enable row level security;
alter table public.tag            force row level security;
alter table public.tag_entry      enable row level security;
alter table public.tag_entry      force row level security;
alter table public.tag_scope      enable row level security;
alter table public.tag_scope      force row level security;
alter table public.tag_event_note enable row level security;
alter table public.tag_event_note force row level security;

-- tag
create policy tag_select on public.tag for select to authenticated
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or id = any ((select private.visible_tag_ids())::bigint[])
    )
  );
create policy tag_insert on public.tag for insert to authenticated
  with check ((select private.is_superadmin()));
create policy tag_update on public.tag for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));
create policy tag_delete on public.tag for delete to authenticated
  using ((select private.is_superadmin()));

-- tag_entry (the entries themselves stay behind entries' own RLS)
create policy tag_entry_select on public.tag_entry for select to authenticated
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or tag_id = any ((select private.visible_tag_ids())::bigint[])
    )
  );
create policy tag_entry_insert on public.tag_entry for insert to authenticated
  with check ((select private.is_superadmin()));
create policy tag_entry_update on public.tag_entry for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));
create policy tag_entry_delete on public.tag_entry for delete to authenticated
  using ((select private.is_superadmin()));

-- tag_scope: a visible tag shows ALL its departments, not only the caller's.
create policy tag_scope_select on public.tag_scope for select to authenticated
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or tag_id = any ((select private.visible_tag_ids())::bigint[])
    )
  );
create policy tag_scope_insert on public.tag_scope for insert to authenticated
  with check ((select private.is_superadmin()));
create policy tag_scope_update on public.tag_scope for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));
create policy tag_scope_delete on public.tag_scope for delete to authenticated
  using ((select private.is_superadmin()));

-- tag_event_note
create policy tag_event_note_select on public.tag_event_note for select to authenticated
  using (
    (select private.is_staff())
    and (
      (select private.is_admin_or_above())
      or tag_id = any ((select private.visible_tag_ids())::bigint[])
    )
  );
create policy tag_event_note_insert on public.tag_event_note for insert to authenticated
  with check ((select private.is_superadmin()));
create policy tag_event_note_update on public.tag_event_note for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));
create policy tag_event_note_delete on public.tag_event_note for delete to authenticated
  using ((select private.is_superadmin()));

revoke all on public.tag, public.tag_entry, public.tag_scope, public.tag_event_note from anon, public;
grant select, insert, update, delete
  on public.tag, public.tag_entry, public.tag_scope, public.tag_event_note to authenticated;

-- ============================================================================
-- 6. Cost per tag per event
--    security_invoker: tag_entry and entries RLS both apply, so a dept user's
--    totals only include entries they can see.
-- ============================================================================

create view public.tag_cost_by_event with (security_invoker = true) as
select
  te.tag_id,
  e.event_id,
  coalesce(sum(e.amount) filter (where not e.is_void), 0)::numeric(14,2) as cost,
  count(*) filter (where not e.is_void)                                 as entry_count,
  count(*) filter (where e.is_void)                                     as voided_count
from public.tag_entry te
join public.entries e on e.id = te.entry_id
group by te.tag_id, e.event_id;

revoke all on public.tag_cost_by_event from anon, public;
grant select on public.tag_cost_by_event to authenticated;

-- ============================================================================
-- 7. Tags active in event X: start event <= X and (end event is null or X <= end).
--    Security invoker, so tag RLS applies to the caller. Event order is inlined
--    (authenticated has no USAGE on the private schema).
--    PostgREST: rpc('tags_active_in_event', { p_event_id }) returns tag rows.
-- ============================================================================

create or replace function public.tags_active_in_event(p_event_id bigint)
returns setof public.tag
language sql stable security invoker set search_path = '' as $$
  select t.*
  from public.tag t
  join public.event x  on x.id = p_event_id
  join public.event s  on s.id = t.start_event_id
  left join public.event en on en.id = t.end_event_id
  where
    -- start <= x
    (s.id = x.id or case
       when s.starts_on is not null and x.starts_on is not null and s.starts_on <> x.starts_on
         then s.starts_on < x.starts_on
       else (length(s.hijri_year), s.hijri_year) < (length(x.hijri_year), x.hijri_year)
     end)
    and (
      en.id is null
      -- x <= end
      or en.id = x.id
      or case
           when x.starts_on is not null and en.starts_on is not null and x.starts_on <> en.starts_on
             then x.starts_on < en.starts_on
           else (length(x.hijri_year), x.hijri_year) < (length(en.hijri_year), en.hijri_year)
         end
    )
$$;

revoke all on function public.tags_active_in_event(bigint) from public, anon;
grant execute on function public.tags_active_in_event(bigint) to authenticated;
