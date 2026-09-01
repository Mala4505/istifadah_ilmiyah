-- Entry-type lookup table, mirroring entry_status / hub_status
-- (20260808000009 / 20260808000010): entries.type stays a text column with
-- its CHECK constraint -- Postgres has no "add value" for a plain CHECK the
-- way it does for a real enum type (20260828000002's own reasoning) -- but
-- every OTHER enum-like dimension on the Entries screen (status, hub status,
-- department, ...) backs its filter dropdown with a real table instead of a
-- hardcoded TS array. This table gives `type` the same treatment, so the
-- Entries filter's Type dropdown reads from the database rather than
-- mirroring components/entries/types.ts's EntryType union by hand.
--
-- Not a rename of entries.type to a FK column -- that would touch every
-- existing query/import path keyed on the raw text value for comparatively
-- little benefit over this lookup table, which already lets the dropdown
-- (and any future display code) resolve DB-driven labels.
create table public.entry_type (
  code text primary key,
  label text not null,
  sort_order int not null
);

-- Seeded from the CURRENT entries_type_check constraint (20260828000002 --
-- the most recent migration to touch it): invoice, reimbursement,
-- advance_payment, invoice_against_uplaq. Keep this table's rows and that
-- CHECK constraint's value list in sync if either ever changes.
insert into public.entry_type (code, label, sort_order) values
  ('invoice', 'Invoice', 1),
  ('reimbursement', 'Reimbursement', 2),
  ('advance_payment', 'Advance', 3),
  ('invoice_against_uplaq', 'IAU', 4);

alter table public.entry_type enable row level security;
alter table public.entry_type force row level security;

create policy entry_type_select on public.entry_type for select to authenticated
  using ((select private.is_staff()));
