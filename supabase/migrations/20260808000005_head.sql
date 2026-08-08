-- The 42 granular heads from master.xlsx. Hub-internal. NOT the source system's heads.
create table public.head (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  head_number int not null,              -- 1..42, staff refer to these by number
  name text not null,
  is_active boolean not null default true,
  unique (department_id, head_number),
  unique (department_id, name)
);
create index head_department_idx on public.head (department_id);
-- seed: 42 rows under department_id=1, head_number/name exactly as in master.xlsx
