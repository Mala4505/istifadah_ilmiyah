-- Entry tags: a linked entry's DEPARTMENT changing now reaches its tags too.
-- Follow-up to 20261105100000_entry_tags.sql. Plan: docs/entry-tags-plan.md, decision 7.
--
-- The first migration's entries trigger only fired when sub_department_id changed to a
-- non-null value. Moving an entry to another department (with no sub-department change,
-- or with the sub-department cleared / still empty) therefore never added the new
-- department to the tags the entry is linked to.
--
-- Now the scope row is upserted whenever the entry has a department and either its
-- department_id or its sub_department_id changed:
--   * department change, no sub-department      -> department-only row for the new department
--   * sub-department set later                  -> (department, sub-department) row, as before
--   * sub-department kept from the OLD department after a department change
--       -> the sub-department does not belong to the new department, so only the
--          department-only row is added (never a mismatched pair)
-- Scope rows are still NEVER removed (decision 8): the old department stays on the tag.
-- ON CONFLICT DO NOTHING keeps it idempotent and leaves an existing row's `source` alone.
--
-- The trigger fires on any column change, not `update of ...`, because the BEFORE trigger
-- private.fill_entry_sub_department can set sub_department_id without it being in SET.
--
-- Function and trigger keep their names from the first migration (the trigger is dropped
-- and recreated because its WHEN condition changes; `create or replace trigger` needs
-- PostgreSQL 14+, drop/create works everywhere).
--
-- Staging: run the same SQL with `public.` -> `staging.` and `private.` ->
-- `staging_private.` (docs/staging.md).

create or replace function private.entries_tag_scope_from_sub_department() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_sub_department_id bigint;
begin
  -- Only pair the sub-department with the department when it belongs to it.
  if new.sub_department_id is not null then
    select s.id into v_sub_department_id
    from public.sub_department s
    where s.id = new.sub_department_id
      and s.department_id = new.department_id;
  end if;

  insert into public.tag_scope (tag_id, department_id, sub_department_id, source)
  select te.tag_id, new.department_id, v_sub_department_id, 'entry'
  from public.tag_entry te
  where te.entry_id = new.id
  on conflict on constraint tag_scope_tag_department_sub_department_key do nothing;
  return null;
end;
$$;

drop trigger if exists entries_tag_scope_from_sub_department on public.entries;

create trigger entries_tag_scope_from_sub_department after update on public.entries
  for each row
  when (new.department_id is not null
        and (new.department_id is distinct from old.department_id
             or new.sub_department_id is distinct from old.sub_department_id))
  execute function private.entries_tag_scope_from_sub_department();

revoke all on function private.entries_tag_scope_from_sub_department() from public, anon, authenticated;
