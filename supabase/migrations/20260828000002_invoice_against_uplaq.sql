-- The Dept module's FOURTH tab: "Invoice Against Uplaq" (IAU) -- the final
-- invoice raised against an advance already paid out.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS TAB IS, TALLIED AGAINST THE ADVANCE PAYMENT TAB (2026-08-28)
--
-- Column-for-column against a real Advance Payment scrape, IAU drops INVOICE
-- NUMBER and UPLAQ AMOUNT, and adds one column of its own: BALANCE PAYABLE.
-- Everything else (UBBL, MAIN, BUDGET HEAD, VENDOR, INVOICE AMOUNT, STATUS,
-- DATE, DEPARTMENT) it shares with that tab.
--
-- The arithmetic was verified exactly, to the rupee, on both live rows:
--
--   BALANCE PAYABLE = (IAU Invoice Amount - Advance Uplaq Amount) - 1% TDS
--
--   IAU_202608272: 20,00,000 - 5,12,500 = 14,87,500, less 1% -> 14,72,625
--   IAU_202608271:  8,00,000 - 5,10,000 =  2,90,000, less 1% ->  2,87,100
--
-- Note the IAU row carries the FINAL invoice amount, which differs from the
-- provisional figure on the advance row (20,00,000 vs 6,15,000 for the first
-- pair). So entries.amount for an IAU row is that final invoice amount, and
-- balance_payable is kept beside it rather than derived -- the portal is the
-- authority on what is still owed, and re-deriving it here would bake in a
-- TDS rate that is not ours to assume stays at 1%.
--
-- WHY settles_entry_id IS NOT POPULATED YET
--
-- entries.settles_entry_id already exists for exactly this ("this invoice
-- settles that advance"), but the IAU list view renders NOTHING that
-- identifies which advance a row settles: the numbers do not encode it
-- (IAU_202608272 vs ADP_202608071), and the only available correspondence is
-- vendor + budget head, which is precisely the fuzzy financial linkage
-- lib/import/run-portal-import.ts's findEntry refuses on the grounds that a
-- wrong guess produces a confident wrong answer. One vendor with two
-- advances under one head would silently settle the wrong one. So IAU rows
-- import unlinked (settles_entry_id null) until the portal gives a real
-- identifier to join on -- user decision, 2026-08-28.
-- ---------------------------------------------------------------------------

begin;

-- ---- 1. a fourth entry type ----------------------------------------------
-- Drop and re-add with the full list, the same way every migration that has
-- touched this constraint does (Postgres has no "add value" for a plain
-- CHECK the way it does for an enum type).
alter table public.entries drop constraint if exists entries_type_check;
alter table public.entries add constraint entries_type_check
  check (type in ('invoice','reimbursement','advance_payment','invoice_against_uplaq'));

-- ---- 2. its 1:1 extension table ------------------------------------------
-- Same class-table-inheritance shape as reimbursement_detail /
-- advance_payment_detail (20260827000001): entry_id IS the primary key,
-- FK'd straight to entries(id), holding only the column this tab has that
-- invoice-shaped `entries` does not.
create table public.invoice_against_uplaq_detail (
  entry_id bigint primary key references public.entries(id),
  -- The tab's BALANCE PAYABLE: what remains owed after the advance already
  -- paid and TDS. entries.amount holds the tab's INVOICE AMOUNT.
  balance_payable numeric(14,2),
  import_batch_id bigint references public.import_batch(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger invoice_against_uplaq_detail_set_updated_at
  before update on public.invoice_against_uplaq_detail
  for each row execute function private.set_updated_at();

alter table public.invoice_against_uplaq_detail enable row level security;

-- Mirrors the other two detail tables' policy exactly: department-scoped
-- select for `authenticated` via a join back to entries. No insert/update
-- policy -- populated only by the import pipeline's service-role `pg`
-- client, which bypasses RLS, same as entries rows from import.
create policy invoice_against_uplaq_detail_select on public.invoice_against_uplaq_detail
  for select to authenticated
  using (exists (
    select 1 from public.entries e
     where e.id = entry_id and (select private.can_see_department(e.department_id))
  ));

commit;
