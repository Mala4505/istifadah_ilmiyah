-- The Hub-owned status is a separate dimension from entry_status. 'Awaiting
-- verification' and 'awaiting validation' are set by staff in this portal and pushed
-- back out to the modules; they must never share a table or column with the imported
-- statuses, or an import would overwrite a decision a human made (§3.3).
create table public.hub_status (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  sort_order int not null,
  is_exportable boolean not null default true,   -- does this state get pushed back?
  is_terminal boolean not null default false
);
-- seed (see seed.sql, inserted in this exact order so id=1 resolves to 'not_set',
-- matching public.entries.hub_status_id's `default 1` in 20260808000013_entries.sql):
--   1 = not_set               'Not set'               (resting state on import; not exported)
--   2 = awaiting_verification 'Awaiting Verification' (Hub-owned, exported)
--   3 = awaiting_validation   'Awaiting Validation'   (Hub-owned, exported)
-- Add further states as a plain insert -- no migration, per the text+CHECK-free lookup design.
