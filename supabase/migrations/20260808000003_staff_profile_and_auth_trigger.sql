-- department_id has no inline FK here: public.department is created in the *next*
-- migration (20260808000004_department.sql), even though staff_profile is ordered
-- before it in §10's file list. The FK constraint is added at the end of
-- 20260808000004_department.sql, once the referenced table exists. This mirrors the
-- same forward-reference pattern used for public.import_row_log.entry_id ->
-- public.entries (see 20260808000011 / 20260808000014).
create table public.staff_profile (
  id uuid primary key references auth.users(id),
  display_name text not null,
  role text not null default 'reviewer' check (role in ('admin','reviewer','viewer')),
  department_id bigint,   -- null = all departments; FK added in 20260808000004_department.sql
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
-- every FK indexed (§3 preamble) -- partial, since null (all-departments) is common
create index staff_profile_department_idx on public.staff_profile (department_id)
  where department_id is not null;

-- v1 had no way for this row to exist. Without it, every first login fails is_staff() forever.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.staff_profile (id, display_name, role, is_active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'viewer', false)
  on conflict (id) do nothing;
  return new;
end; $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
-- New users land inactive with role 'viewer'. An admin activates and assigns.
