-- Global, admin-configurable operational settings (docs/ocr-execution-decision.md
-- follow-up: "add validation that blocks an upload too large to complete in
-- one pass, with the limit itself dynamic from /settings"). A singleton row,
-- not a key-value table -- every setting here is a known, typed column, and
-- this codebase's convention throughout (staff_profile's keymap_overrides,
-- source_document's typed columns, etc.) is typed columns over ad-hoc KV.
-- `id` pinned to `1` by the check constraint enforces exactly one row ever
-- exists; there is no insert policy for `authenticated` below, so the seed
-- row inserted here is the only one that will ever exist.
create table public.app_settings (
  id int primary key default 1,
  -- Measured ceiling before this column existed: ~28 pages took ~54s against
  -- extraction's per-page Haiku pipeline (4 pages concurrent, ~7.7s/batch),
  -- already uncomfortably close to the 60s platform request limit
  -- (app/api/documents/ingest/route.ts's maxDuration). Default set below that
  -- edge, not at it, to leave margin for real-world variance (escalation
  -- calls, network jitter, a slower day on Anthropic's side) rather than the
  -- exact measured wall.
  max_upload_pages int not null default 20 check (max_upload_pages > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint app_settings_singleton check (id = 1)
);

insert into public.app_settings (id) values (1);

comment on table public.app_settings is
  'Singleton row of admin-configurable, app-wide operational settings. Read via lib/upload-limits.ts; edited from /settings (admin-only section, lib/actions/settings.ts).';
comment on column public.app_settings.max_upload_pages is
  'A PDF upload with more pages than this is rejected at ingest time (app/api/documents/ingest/route.ts), before storage or any extraction spend, with a friendly error naming the page count and this limit.';

alter table public.app_settings enable row level security;

-- Read: every signed-in staff member (the ingest route reads this via the
-- admin/service-role client regardless, but the settings PAGE reads it
-- through the session client, and there is no reason to hide an operational
-- limit from non-admin staff).
create policy app_settings_select on public.app_settings
  for select
  to authenticated
  using ((select private.is_staff()));

-- Update: admin-or-above only (private.is_admin(), redefined by
-- 20260819000003_role_rbac_v2.sql to mean exactly that) -- this is a
-- system-wide operational limit, not a per-user preference like the keymap
-- columns on staff_profile, so it is gated tighter than "any signed-in
-- staff member."
create policy app_settings_update on public.app_settings
  for update
  to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

grant select, update on public.app_settings to authenticated;
