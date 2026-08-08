create table public.department (
  id bigint generated always as identity primary key,
  name text not null unique,
  external_code text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
-- seed: id=1 'Venue Setup'. More arrive via import with zero schema change.

-- Deferred FK: public.staff_profile.department_id could not reference public.department
-- at creation time in 20260808000003_staff_profile_and_auth_trigger.sql because this
-- table did not exist yet (see the comment there). Add it now that it does.
alter table public.staff_profile
  add constraint staff_profile_department_id_fkey
  foreign key (department_id) references public.department(id);
