-- One row per bill inside an entry, plus an invoice date.
--
-- Why: the portal list (what the scrape reads) shows ONE row per UBBL, but the
-- Dept-module Excel export lists every bill under that UBBL separately, each
-- with its own invoice number, invoice date, amount and budget head. Examples
-- seen 2026-10-09: one reimbursement split across 5 heads; one UBBL carrying two
-- different vendors' bills. `entries` keeps a single amount/invoice_number per
-- UBBL, so the per-bill detail (and the per-head split) was being lost.
--
-- entries stays the source of truth for the UBBL-level amount (what the scrape
-- writes). entry_bill_line is detail UNDER it, filled from the Excel export by
-- scripts/import-bill-lines.mjs, and ONLY for UBBLs that hold more than one bill
-- (a single-bill entry already has its vendor/invoice/amount on `entries`; a
-- second copy would drift when the scrape updates it). It never changes
-- entries.amount.
--
-- entries.date stays the portal list's DATE column (the entry date). The new
-- entries.invoice_date is the earliest bill date from the export; per-bill
-- dates live on entry_bill_line.invoice_date.

alter table public.entries add column invoice_date date;

create table public.entry_bill_line (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.entries(id) on delete cascade,
  line_no integer not null,                 -- 1-based position under the UBBL in the export
  invoice_number text,
  invoice_date date,
  vendor_raw text,                          -- exactly as exported
  amount numeric(14,2),
  budget_head_raw text,                     -- the export's head label, e.g. 'Sehhah (Medicines)'
  sub_department_id bigint references public.sub_department(id),  -- resolved from budget_head_raw; null if no match
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (entry_id, line_no)
);

create index entry_bill_line_sub_department_idx on public.entry_bill_line (sub_department_id)
  where sub_department_id is not null;

create trigger entry_bill_line_set_updated_at before update on public.entry_bill_line
  for each row execute function private.set_updated_at();

alter table public.entry_bill_line enable row level security;

-- Same visibility as reimbursement_detail (set-based form, 20261005120000):
-- admins see everything, others only their own departments' entries. No write
-- policy for `authenticated` -- only the import script (service role) writes.
create policy entry_bill_line_select on public.entry_bill_line
  for select to authenticated
  using (
    exists (
      select 1 from public.entries e
      where e.id = entry_bill_line.entry_id
        and (
          (select private.is_admin_or_above())
          or e.department_id = any ((select private.my_department_ids())::bigint[])
        )
    )
  );
