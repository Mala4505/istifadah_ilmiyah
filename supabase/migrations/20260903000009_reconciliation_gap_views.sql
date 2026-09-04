-- reporting-blueprint.md §8 Phase Six (Forensics) -- D-05 + D-06.
--
--   D-05  "Ledger vs bill reconciliation -- distribution of the gap between
--          the entry amount and the bill's own total. Most sit at zero; the
--          tail is the report. Top 20 by rupee value."
--   D-06  "Entries with no supporting bill -- not a count, a rupee figure, by
--          department and by vendor. This is the size of the undocumented pile."
--
-- Three views:
--
--   v_ledger_bill_reconciliation -- one row per NON-VOID entry that has a
--     person-verified bill total (document_extraction.total_amount_verified
--     is not null). Carries the ledger figure (entries.amount), the verified
--     bill total, the signed gap (entry_amount - bill_total), its magnitude,
--     and the gap as a percentage of the entry amount. The entry->extraction
--     chain is de-duped with the `distinct on (e.id)` pattern from
--     20260903000003_purchase_tree_view.sql so a multi-document entry cannot
--     fan the output out; the surviving row is the newest verified extraction
--     (verified_at desc, then de.id desc).
--
--   v_entries_without_bill -- one row per NON-VOID entry whose "best" document
--     (see the distinct-on below) still has NO verified total. That is the
--     blueprint's "no supporting bill" = "no USABLE bill": an entry with a
--     document that was uploaded but never verified is as undocumented, for
--     reconciliation purposes, as one with nothing attached -- the reviewer
--     still cannot say what the bill says. `has_document` keeps the two apart
--     (false = nothing uploaded, true = uploaded but unverified) because they
--     are different remediation queues.
--
--   v_entries_without_bill_rollup -- the same population as
--     v_entries_without_bill, pre-aggregated to one row per (dimension,
--     dimension entity, event) for dimension in ('department','vendor'). This
--     exists because the D-06 headline is a RUPEE FIGURE over the whole
--     undocumented pile, and the detail view is capped at the app's ROW_CAP
--     (1000) at the query site -- summing capped rows would under-report the
--     pile on a large corpus. The rollup is not capped by row count in
--     practice (one row per department or vendor), so the loader takes the
--     KPI from here and the table from v_entries_without_bill. Each entry is
--     counted once per dimension, so the 'department'-dimension rows sum to
--     the true grand total (the 'vendor'-dimension rows also sum to it but
--     omit the amount of any entry with a null vendor_id -- use 'department'
--     for the headline).
--
-- Nullability
--   * entries.amount (aka entry_amount) is NULLABLE (it is the renamed
--     tenant_amount, 20260811000003). A null entry_amount yields a null
--     gap_amount / abs_gap_amount / gap_pct in v_ledger_bill_reconciliation
--     and a null contribution to the rollup sums -- the loader buckets those
--     rows as "not computable" rather than "zero gap".
--   * gap_pct divides by nullif(entry_amount, 0), so a zero or null entry
--     amount gives a null gap_pct, never a divide-by-zero.
--   * department_id / vendor_id are nullable on entries; department_name /
--     vendor_display_name are null for those rows (LEFT JOIN to the staff-wide
--     dimension tables).
--
-- Numeric casts: entry_amount, bill_total and total_amount_verified are all
-- numeric(14,2); the arithmetic below stays numeric, but every round() still
-- gets an explicit ::numeric cast to match the house rule from Phase 4
-- (percentile_cont / avg / division can silently be double precision, and
-- round(double, int) does not exist in Postgres).
--
-- RLS / security_invoker
--   Every view here runs `with (security_invoker = true)`, so base-table RLS
--   applies as the calling user. `entries` is department-scoped
--   (can_see_department); source_document, document_extraction, vendor and
--   department are staff-wide. All three views are DRIVEN BY `entries` (inner
--   join in v_ledger_bill_reconciliation, the FROM table in the others), so a
--   department-scoped reviewer simply sees FEWER ROWS -- only entries in their
--   departments -- never a row with null-because-hidden columns. One
--   consequence worth stating: v_entries_without_bill_rollup's sums are
--   therefore scoped to what the caller can see. A full-access user (SA) gets
--   the true organisation-wide undocumented figure; a single-department
--   reviewer gets their department's slice. The D-06 "% of event spend" KPI
--   divides two figures computed under the same scope, so the ratio stays
--   meaningful for both.
--
-- Grants: all three are brand-new objects, not covered by the historical
-- blanket grant (20260808000026) -- each needs its own explicit grant below.
-- event_id is a plain output column on every view; event filtering happens at
-- the query site, matching every Phase 3-5 migration.
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- v_ledger_bill_reconciliation -- D-05
-- ----------------------------------------------------------------------------
create view public.v_ledger_bill_reconciliation with (security_invoker = true) as
with entry_bill as (
  select distinct on (e.id)
    e.id            as entry_id,
    e.department_id,
    e.vendor_id,
    e.invoice_number,
    e.amount        as entry_amount,
    e.date          as entry_date,
    e.event_id,
    de.total_amount_verified as bill_total
  from public.entries e
  join public.source_document sd on sd.entry_id = e.id
  join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  where e.is_void = false
    and de.total_amount_verified is not null
  -- newest verified extraction wins, deterministically
  order by e.id, de.verified_at desc nulls last, de.id desc
)
select
  eb.entry_id,
  eb.department_id,
  d.name as department_name,
  eb.vendor_id,
  v.display_name as vendor_display_name,
  eb.invoice_number,
  eb.entry_amount,
  eb.bill_total,
  round((eb.entry_amount - eb.bill_total)::numeric, 2)      as gap_amount,
  round(abs(eb.entry_amount - eb.bill_total)::numeric, 2)   as abs_gap_amount,
  round(
    (abs(eb.entry_amount - eb.bill_total) / nullif(eb.entry_amount, 0) * 100)::numeric,
    2
  ) as gap_pct,
  eb.entry_date,
  eb.event_id
from entry_bill eb
left join public.department d on d.id = eb.department_id
left join public.vendor v on v.id = eb.vendor_id;

grant select on public.v_ledger_bill_reconciliation to authenticated;

-- ----------------------------------------------------------------------------
-- v_entries_without_bill -- D-06 (detail grain)
-- ----------------------------------------------------------------------------
create view public.v_entries_without_bill with (security_invoker = true) as
with entry_doc as (
  select distinct on (e.id)
    e.id            as entry_id,
    e.department_id,
    e.vendor_id,
    e.amount        as entry_amount,
    e.date          as entry_date,
    e.event_id,
    (sd.id is not null) as has_document,
    de.total_amount_verified
  from public.entries e
  left join public.source_document sd on sd.entry_id = e.id
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  where e.is_void = false
  -- Pick the single most "complete" document per entry: one that carries a
  -- verified total first (if any such exists, the entry is NOT in this
  -- view's population and the outer WHERE drops it), then one that at least
  -- has a source_document, then newest. So `has_document` on the surviving
  -- row is true iff the entry has ANY document at all.
  order by e.id,
    (de.total_amount_verified is null),
    (sd.id is null),
    de.id desc
)
select
  ed.entry_id,
  ed.department_id,
  d.name as department_name,
  ed.vendor_id,
  v.display_name as vendor_display_name,
  ed.entry_amount,
  ed.entry_date,
  ed.has_document,
  ed.event_id
from entry_doc ed
left join public.department d on d.id = ed.department_id
left join public.vendor v on v.id = ed.vendor_id
where ed.total_amount_verified is null;

grant select on public.v_entries_without_bill to authenticated;

-- ----------------------------------------------------------------------------
-- v_entries_without_bill_rollup -- D-06 (headline grain)
-- ----------------------------------------------------------------------------
create view public.v_entries_without_bill_rollup with (security_invoker = true) as
with base as (
  select distinct on (e.id)
    e.id            as entry_id,
    e.department_id,
    e.vendor_id,
    e.amount        as entry_amount,
    e.event_id,
    (sd.id is not null) as has_document,
    de.total_amount_verified
  from public.entries e
  left join public.source_document sd on sd.entry_id = e.id
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  where e.is_void = false
  order by e.id,
    (de.total_amount_verified is null),
    (sd.id is null),
    de.id desc
),
undocumented as (
  select * from base where total_amount_verified is null
)
select
  'department'::text as dimension,
  u.department_id    as dimension_id,
  d.name             as dimension_name,
  u.event_id,
  count(*)                                        as entry_count,
  count(*) filter (where not u.has_document)      as no_document_count,
  coalesce(sum(u.entry_amount), 0)                as undocumented_amount
from undocumented u
left join public.department d on d.id = u.department_id
group by u.department_id, d.name, u.event_id
union all
select
  'vendor'::text     as dimension,
  u.vendor_id        as dimension_id,
  v.display_name     as dimension_name,
  u.event_id,
  count(*)                                        as entry_count,
  count(*) filter (where not u.has_document)      as no_document_count,
  coalesce(sum(u.entry_amount), 0)                as undocumented_amount
from undocumented u
left join public.vendor v on v.id = u.vendor_id
group by u.vendor_id, v.display_name, u.event_id;

grant select on public.v_entries_without_bill_rollup to authenticated;
