-- ZONE, not venue. Scoped to the department, because master.xlsx scopes it to Venue Setup.
create table public.zone (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  zone_number int not null,              -- 1..13
  name text not null,
  is_active boolean not null default true,
  unique (department_id, zone_number)
);
create index zone_department_idx on public.zone (department_id);
-- seed: 13 rows under department_id=1. Note zone 13 = 'OFFICE EXPENSE' — a bucket, not a place.
