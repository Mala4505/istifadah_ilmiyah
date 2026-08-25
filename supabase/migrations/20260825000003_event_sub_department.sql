-- Sub-department feature: event scoping. Mirrors event_admin_head/
-- event_zone (20260822000005_event_scoping.sql:73-83, 104-113) exactly --
-- master rows stay global; this membership table says which sub_department
-- rows are active in a given event.
create table public.event_sub_department (
  event_id           bigint not null references public.event(id) on delete cascade,
  sub_department_id  bigint not null references public.sub_department(id),
  primary key (event_id, sub_department_id)
);

-- Same select-only-for-staff shape as event_department_select/
-- event_admin_head_select/event_zone_select -- membership rows are read to
-- drive per-event dropdown filtering, not a per-department security
-- boundary.
alter table public.event_sub_department enable row level security;
alter table public.event_sub_department force row level security;
create policy event_sub_department_select on public.event_sub_department for select to authenticated
  using ((select private.is_staff()));
grant select on public.event_sub_department to authenticated;

-- Backfill: carry every active sub_department forward into the current
-- event, same as 20260822000005's own backfill did for event_department/
-- event_admin_head/event_zone.
insert into public.event_sub_department (event_id, sub_department_id)
select (select id from public.event where is_current limit 1), id
from public.sub_department where is_active
on conflict do nothing;
