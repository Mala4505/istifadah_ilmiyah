-- Entries <-> Bills many-to-many, Phase 2 (plan: entry-bill links with
-- automatic variance).
--
-- The three variance views. Nothing in the app reads them until Phase 4/5 --
-- this migration only adds them and rebuilds v_ledger_bill_reconciliation on
-- top of v_entry_bill_variance (column names preserved, so
-- lib/reports/surfaces/reconciliation-gap.ts and
-- components/reports/sections/ledger-bill-reconciliation.tsx compile unchanged).
--
--   v_entry_bill_variance   entry grain  entries.amount vs SUM(bill_total) of every linked bill
--   v_bill_entry_variance   bill grain   bill_total vs SUM(entries.amount) of every linked entry
--   v_bill_primary_entry    bill grain   one entry per bill (largest amount wins) -- CARDINALITY
--                                        PRESERVER for the ~20 legacy views rewritten in Phase 4
--
-- bill_total here is coalesce(de.total_amount_verified, de.total_amount_ocr) so
-- the review screen has a live figure before Verify runs. The *reporting* view
-- (v_ledger_bill_reconciliation) stays gated on verified_bill_count > 0, as
-- today.
--
-- ==========================================================================
-- >>> THE DOUBLE-COUNTING RULE <<<
-- ==========================================================================
-- There is no allocation. A bill shared by two entries contributes its FULL
-- total to each of their billed_total figures; an entry covered by two bills
-- contributes its FULL amount to each of their linked_entry_total figures. That
-- is correct and what the reviewer needs PER ROW -- but it means:
--
--   * NEVER sum(billed_total) across v_entry_bill_variance rows, or
--     sum(linked_entry_total) across v_bill_entry_variance rows. Both inflate
--     as soon as anything is shared.
--   * Any org-wide or departmental rupee rollup must aggregate from
--     document_extraction directly (bill grain, each bill once) or attribute
--     through v_bill_primary_entry.
--
-- Every loader that reads these views repeats this rule in its doc comment.
-- ==========================================================================
--
-- RLS: all three run `with (security_invoker = true)`. entry_bill_link's own
-- policy scopes per row (can_see_source_document AND can_see_entry), entries is
-- department-scoped, document_extraction is gated by can_see_source_document.
-- A department-scoped reviewer simply sees fewer links.
--
-- Tolerance: public.within_tally_tolerance (20260908000000) -- the SQL twin of
-- lib/normalize.ts's tallyWithinTolerance. Kept in lockstep; parity asserted in
-- vitest.integration.

-- --------------------------------------------------------------------------
-- v_entry_bill_variance -- entry grain
-- --------------------------------------------------------------------------
create view public.v_entry_bill_variance with (security_invoker = true) as
with linked as (
  -- One entry_bill_link row per (entry, non-null bill) is guaranteed by
  -- entry_bill_link_bill_entry_key, so a plain SUM over the join cannot
  -- double-count a bill for the same entry. Placeholder rows
  -- (document_extraction_id null) contribute 0 -- the bill is not known yet.
  select
    l.entry_id,
    count(distinct l.document_extraction_id)
      filter (where l.document_extraction_id is not null)          as bill_count,
    count(distinct l.source_document_id)                           as document_count,
    count(*) filter (where de.total_amount_verified is not null)   as verified_bill_count,
    coalesce(sum(coalesce(de.total_amount_verified, de.total_amount_ocr)), 0)
                                                                   as billed_total
  from public.entry_bill_link l
  left join public.document_extraction de on de.id = l.document_extraction_id
  group by l.entry_id
)
select
  e.id                    as entry_id,
  e.department_id,
  e.vendor_id,
  e.invoice_number,
  e.amount                as entry_amount,
  e.date                  as entry_date,
  e.event_id,
  ln.bill_count,
  ln.document_count,
  ln.verified_bill_count,
  round(ln.billed_total::numeric, 2)::numeric(14, 2)               as billed_total,
  round((e.amount - ln.billed_total)::numeric, 2)                  as variance_amount,
  round((abs(e.amount - ln.billed_total) / nullif(e.amount, 0) * 100)::numeric, 2)
                                                                   as variance_pct,
  public.within_tally_tolerance(e.amount, ln.billed_total)         as within_tolerance
from public.entries e
join linked ln on ln.entry_id = e.id
where e.is_void = false;

comment on view public.v_entry_bill_variance is
  'Per NON-VOID entry that has >=1 entry_bill_link: entries.amount vs SUM of coalesce(verified,ocr) total over every linked bill. DOUBLE-COUNTING: billed_total is per-row honest and MUST NOT be summed across rows once any bill is shared -- roll rupees up from document_extraction or v_bill_primary_entry instead. Feature: entry-bill links, 2026-09-08.';

grant select on public.v_entry_bill_variance to authenticated;

-- --------------------------------------------------------------------------
-- v_bill_entry_variance -- bill grain
-- --------------------------------------------------------------------------
create view public.v_bill_entry_variance with (security_invoker = true) as
select
  de.id                   as document_extraction_id,
  de.source_document_id,
  sd.event_id,
  coalesce(de.total_amount_verified, de.total_amount_ocr)          as bill_total,
  coalesce(sum(e.amount), 0)                                       as linked_entry_total,
  round(
    (coalesce(de.total_amount_verified, de.total_amount_ocr) - coalesce(sum(e.amount), 0))::numeric, 2
  )                                                                as variance_amount,
  round(
    (abs(coalesce(de.total_amount_verified, de.total_amount_ocr) - coalesce(sum(e.amount), 0))
      / nullif(coalesce(de.total_amount_verified, de.total_amount_ocr), 0) * 100)::numeric, 2
  )                                                                as variance_pct,
  public.within_tally_tolerance(
    coalesce(de.total_amount_verified, de.total_amount_ocr),
    coalesce(sum(e.amount), 0)
  )                                                                as within_tolerance,
  count(distinct e.id)                                             as entry_link_count,
  coalesce(array_agg(distinct e.id) filter (where e.id is not null), '{}'::bigint[])
                                                                   as entry_ids
from public.document_extraction de
join public.source_document sd on sd.id = de.source_document_id
left join public.entry_bill_link l on l.document_extraction_id = de.id
left join public.entries e on e.id = l.entry_id and e.is_void = false
group by de.id, de.source_document_id, sd.event_id,
         de.total_amount_verified, de.total_amount_ocr;

comment on view public.v_bill_entry_variance is
  'Per bill (document_extraction): coalesce(verified,ocr) total vs SUM of entries.amount over every linked (non-void) entry. DOUBLE-COUNTING: linked_entry_total is per-row honest and MUST NOT be summed across rows once any entry is shared. Feature: entry-bill links, 2026-09-08.';

grant select on public.v_bill_entry_variance to authenticated;

-- --------------------------------------------------------------------------
-- v_bill_primary_entry -- cardinality preserver
-- --------------------------------------------------------------------------
-- distinct on (document_extraction_id): the largest linked entry amount wins,
-- l.id as the deterministic tie-break. Legacy views that today read
-- coalesce(de.entry_id, sd.entry_id) swap to a LEFT JOIN on this view, keeping
-- their row count (and therefore every rupee column) exactly as it was.
create view public.v_bill_primary_entry with (security_invoker = true) as
select distinct on (l.document_extraction_id)
  l.document_extraction_id,
  l.entry_id
from public.entry_bill_link l
join public.entries e on e.id = l.entry_id
where l.document_extraction_id is not null
order by l.document_extraction_id, e.amount desc nulls last, l.id;

comment on view public.v_bill_primary_entry is
  'One entry per bill: largest linked entries.amount wins, entry_bill_link.id as tie-break. Cardinality preserver for the legacy reader views (Phase 4). Feature: entry-bill links, 2026-09-08.';

grant select on public.v_bill_primary_entry to authenticated;

-- --------------------------------------------------------------------------
-- v_ledger_bill_reconciliation -- rebuilt on v_entry_bill_variance
-- --------------------------------------------------------------------------
-- Column list and order preserved EXACTLY (entry_id, department_id,
-- department_name, vendor_id, vendor_display_name, invoice_number,
-- entry_amount, bill_total, gap_amount, abs_gap_amount, gap_pct, entry_date,
-- event_id) so reconciliation-gap.ts and ledger-bill-reconciliation.tsx are
-- untouched. `create or replace` keeps existing grants.
--
-- Meaning change (the intended fix): bill_total was "newest verified bill";
-- it is now "SUM of coalesce(verified,ocr) over every linked bill". Still gated
-- to entries with >=1 verified linked bill (verified_bill_count > 0). This is a
-- per-entry detail view (top-N by rupee value), not a summed rollup, so the
-- double-counting rule does not bite it -- update the surface file's doc
-- comment to say so.
--
-- Numbers will also move because the old view's `join source_document sd on
-- sd.entry_id = e.id` made an entry matched ONLY at bill grain invisible here;
-- it is now visible. Take a before/after snapshot of the Forensics page (D-05).
create or replace view public.v_ledger_bill_reconciliation with (security_invoker = true) as
select
  ebv.entry_id,
  ebv.department_id,
  d.name                                             as department_name,
  ebv.vendor_id,
  v.display_name                                     as vendor_display_name,
  ebv.invoice_number,
  ebv.entry_amount::numeric(14, 2)                   as entry_amount,
  ebv.billed_total::numeric(14, 2)                   as bill_total,
  ebv.variance_amount::numeric                       as gap_amount,
  round(abs(ebv.variance_amount)::numeric, 2)        as abs_gap_amount,
  ebv.variance_pct::numeric                          as gap_pct,
  ebv.entry_date,
  ebv.event_id
from public.v_entry_bill_variance ebv
left join public.department d on d.id = ebv.department_id
left join public.vendor v on v.id = ebv.vendor_id
where ebv.verified_bill_count > 0;
