-- Phase 6 Step 1 (docs/event-scoping-and-review-fixes-plan.md §1; the
-- "Foundation" step in the accompanying rollout plan): the multi-year
-- "event" concept, previously nonexistent anywhere in the schema.
--
-- Central decision (doc §1.1): master identity (department/admin_head/zone/
-- budget_head) stays ONE permanent shared list per table -- copying master
-- rows per event would reintroduce exactly the fuzzy-name-matching problem
-- vendor/vendor_alias already exists to avoid. A new event_<master>
-- membership table per master tracks which master rows are active in a
-- given event instead.
--
-- Refinement resolved with the user (the doc itself is ambiguous/wrong here:
-- it calls the table "budget_head_master", which does not exist -- the real
-- table is `budget_head`): unlike department/admin_head/zone, which are
-- pre-curated and never auto-created during import, `budget_head` rows ARE
-- auto-created during the entries import whenever a `raw_label` doesn't
-- already exist for that department (lib/import/run-import.ts:268-281). So
-- `event_budget_head` membership can't be populated by manual carry-forward
-- alone -- a later stream must also upsert an event_budget_head row
-- (on-conflict-do-nothing) whenever the importer resolves-or-creates a
-- budget_head row. That is NOT built here; this migration only needs to give
-- event_budget_head a plain composite primary key that supports it.
--
-- No RLS policy touches event scoping: per doc §1.3, event visibility is an
-- app-query-level concern, not a security boundary. RLS stays exactly as
-- department-based as it is today (private.can_see_department() etc.,
-- 20260808000026_rls_policies.sql) -- nothing here changes it.

-- ---------------------------------------------------------------------------
-- event
-- ---------------------------------------------------------------------------

create table public.event (
  id           bigserial primary key,
  name         text not null,                     -- 'Istifadah Ilmiyah 1448 H'
  hijri_year   text not null unique,               -- '1448'
  starts_on    date,
  ends_on      date,
  is_current   boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Exactly one event may be "current" at a time -- the app's default
-- selection when no active_event_id cookie is set (lib/events/current.ts).
create unique index event_one_current on public.event (is_current) where is_current;

alter table public.event enable row level security;
alter table public.event force row level security;

create policy event_select on public.event for select to authenticated
  using ((select private.is_staff()));
-- No insert/update/delete policy for `authenticated` -- events are created
-- only via lib/actions/events.ts's createEvent, which is admin-gated in the
-- application layer and writes over a direct (non-PostgREST, RLS-bypassing)
-- `pg` connection so the is_current flip and the new event insert land in
-- one transaction, exactly like lib/import/run-import.ts's transactional
-- writes. Deny-by-default here for `authenticated` is deliberate.

grant select on public.event to authenticated;

-- ---------------------------------------------------------------------------
-- membership tables -- master rows stay global; each says which master rows
-- are active in a given event. (event_id, <master>_id) is both the PK and
-- the unique constraint an `on conflict do nothing` upsert needs.
-- ---------------------------------------------------------------------------

create table public.event_department (
  event_id      bigint not null references public.event(id) on delete cascade,
  department_id bigint not null references public.department(id),
  primary key (event_id, department_id)
);

create table public.event_admin_head (
  event_id      bigint not null references public.event(id) on delete cascade,
  admin_head_id bigint not null references public.admin_head(id),
  primary key (event_id, admin_head_id)
);

create table public.event_zone (
  event_id bigint not null references public.event(id) on delete cascade,
  zone_id  bigint not null references public.zone(id),
  primary key (event_id, zone_id)
);

create table public.event_budget_head (
  event_id       bigint not null references public.event(id) on delete cascade,
  budget_head_id bigint not null references public.budget_head(id),
  primary key (event_id, budget_head_id)
);

-- Same select-only-for-staff shape as department_select/zone_select/
-- budget_head_select (20260808000026) -- these membership rows are read to
-- drive per-event dropdown filtering, not a per-department security
-- boundary, same reasoning department_select already documents for why it
-- isn't scoped by can_see_department.

alter table public.event_department enable row level security;
alter table public.event_department force row level security;
create policy event_department_select on public.event_department for select to authenticated
  using ((select private.is_staff()));
grant select on public.event_department to authenticated;

alter table public.event_admin_head enable row level security;
alter table public.event_admin_head force row level security;
create policy event_admin_head_select on public.event_admin_head for select to authenticated
  using ((select private.is_staff()));
grant select on public.event_admin_head to authenticated;

alter table public.event_zone enable row level security;
alter table public.event_zone force row level security;
create policy event_zone_select on public.event_zone for select to authenticated
  using ((select private.is_staff()));
grant select on public.event_zone to authenticated;

alter table public.event_budget_head enable row level security;
alter table public.event_budget_head force row level security;
create policy event_budget_head_select on public.event_budget_head for select to authenticated
  using ((select private.is_staff()));
grant select on public.event_budget_head to authenticated;

-- ---------------------------------------------------------------------------
-- event_id on the six transactional-core tables (doc §1.2's "gets event_id
-- not null references event(id)" list). Nullable first, backfilled below,
-- then locked to NOT NULL in the same migration -- at current volumes (14
-- entries, 5 source_documents, per the doc's §1.4) this is instant.
-- ---------------------------------------------------------------------------

alter table public.entries add column event_id bigint references public.event(id);
alter table public.source_document add column event_id bigint references public.event(id);
alter table public.import_batch add column event_id bigint references public.event(id);
alter table public.status_export_batch add column event_id bigint references public.event(id);
alter table public.budget_allocation add column event_id bigint references public.event(id);
alter table public.department_budget_allocation add column event_id bigint references public.event(id);

-- ---------------------------------------------------------------------------
-- Backfill: event 1 = the current, already-running event.
-- ---------------------------------------------------------------------------

insert into public.event (name, hijri_year, is_current)
values ('Istifadah Ilmiyah 1448 H', '1448', true);

update public.entries set event_id = 1 where event_id is null;
update public.source_document set event_id = 1 where event_id is null;
update public.import_batch set event_id = 1 where event_id is null;
update public.status_export_batch set event_id = 1 where event_id is null;
update public.budget_allocation set event_id = 1 where event_id is null;
update public.department_budget_allocation set event_id = 1 where event_id is null;

-- Membership backfill respects is_active where the master table has that
-- column (department/admin_head/zone). budget_head has no is_active column
-- at all (per the refinement above -- it's discovered per-import, not
-- pre-curated), so every existing row is treated as active in event 1.
insert into public.event_department (event_id, department_id)
select 1, id from public.department where is_active;

insert into public.event_admin_head (event_id, admin_head_id)
select 1, id from public.admin_head where is_active;

insert into public.event_zone (event_id, zone_id)
select 1, id from public.zone where is_active;

insert into public.event_budget_head (event_id, budget_head_id)
select 1, id from public.budget_head;

alter table public.entries alter column event_id set not null;
alter table public.source_document alter column event_id set not null;
alter table public.import_batch alter column event_id set not null;
alter table public.status_export_batch alter column event_id set not null;
alter table public.budget_allocation alter column event_id set not null;
alter table public.department_budget_allocation alter column event_id set not null;

-- FK columns are not auto-indexed by Postgres (the same reasoning
-- department_budget_allocation's own migration documents for its
-- import_batch_id index) -- every parallel rollout stream after this one
-- filters its main queries by event_id, so these indexes are load-bearing
-- from day one, not a future optimization.
create index entries_event_idx on public.entries (event_id);
create index source_document_event_idx on public.source_document (event_id);
create index import_batch_event_idx on public.import_batch (event_id);
create index status_export_batch_event_idx on public.status_export_batch (event_id);
create index budget_allocation_event_idx on public.budget_allocation (event_id);
create index department_budget_allocation_event_idx on public.department_budget_allocation (event_id);
