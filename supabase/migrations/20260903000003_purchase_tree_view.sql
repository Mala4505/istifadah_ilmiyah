-- reporting-blueprint.md §3 Family C / §4 C-02 (flagship) -- Purchase tree.
-- "Item family -> catalogue item -> vendor -> the specific bills, drillable
-- at every level. The exploration surface for 'where did ₹X actually go'."
--
--   v_purchase_tree -- one row per rate_reference observation that has a
--     resolvable item_family_id, carrying every level's id + label so the
--     app can build the four-level tree client-side (family -> catalog item
--     -> vendor -> bill) without a second query per level.
--
-- Deliberately NOT filtering `is_comparable = true`: that flag marks whether
-- a rate is fit to *benchmark* against other vendors (v_rate_observation /
-- C-04's job). C-02 asks a different question -- "where did the money go" --
-- and a lump-sum or single-vendor-only line is still real spend that belongs
-- in the tree even though it can't be benchmarked. The only filter here is
-- `item_family_id is not null`, i.e. the line has been classified at all.
--
-- Sparseness: item_family_id/item_catalog_id are backfilled by a separate
-- proposer pass and are expected to be null on much of the corpus today
-- (20260814000001's header, restated in v_rate_observation's header above).
-- This view is a strict superset of v_rate_observation's row set (same base
-- table and same `item_family_id is not null` predicate, minus the
-- `is_comparable` narrowing) -- since v_rate_observation already ships as a
-- working per-observation report (20260903000002), this view cannot be
-- emptier than that one already proven to have rows. A coarser
-- v_spend_by_family union was considered and rejected: that view is grouped
-- by item_family_id via a LEFT JOIN from item_family, so a family with zero
-- rate_reference rows shows up there with total_spend = 0 -- unioning it in
-- would add zero-value family nodes, not recover any missing spend. If the
-- corpus ever needs a coarser fallback it has to attach at the line-item
-- level (document_extraction_line_item, which is not yet family-classified
-- at all), not at this view.
--
-- vendor_id, entry_id, department_id/name and event_id all come from
-- rate_reference's optional links (a rate can be observed with no linked
-- entry) via LEFT JOINs, same nullability contract as v_rate_observation.
-- invoice_number prefers entries.invoice_number (import-owned) and falls
-- back to the linked document_extraction's verified/OCR invoice number --
-- resolved through a dedup'd `entry_invoice` CTE (one row per entry_id,
-- preferring a verified value, then any value, then the newest extraction)
-- so the left join can't fan out the observation-grain output when an entry
-- carries more than one source_document/extraction, mirroring
-- v_instrument_type_mix's `distinct on (e.id)` pattern (20260903000002).
--
-- No GROUP BY anywhere -- this is observation grain, one row in equals one
-- row out, so event_id needs no special GROUP-BY handling; a family/vendor
-- active across two events simply appears as two (or more) separate rows,
-- correctly un-summed.
--
-- Department-leak note (same property as v_rate_observation): vendor,
-- rate_reference, item_family and item_catalog are staff-wide with no
-- department scoping. `entries` IS department-scoped by RLS
-- (can_see_department), so a department-scoped reviewer querying this view
-- still sees every family/catalog/vendor/rate row, but department_id,
-- department_name, event_id and invoice_number read null for a row whose
-- entry sits outside their department (the LEFT JOIN to entries returns no
-- row, not a permission error).
--
-- security_invoker = true (every view in this codebase runs as the calling
-- user so base-table RLS applies). This is a brand-new object, not covered
-- by the historical blanket grant (20260808000026) or any later one -- it
-- needs its own explicit grant below.
-- ----------------------------------------------------------------------------
create view public.v_purchase_tree with (security_invoker = true) as
with entry_invoice as (
  select distinct on (e.id)
    e.id as entry_id,
    coalesce(e.invoice_number, de.invoice_number_verified, de.invoice_number_ocr) as invoice_number
  from public.entries e
  left join public.source_document sd on sd.entry_id = e.id
  left join public.document_extraction de
    on de.source_document_id = sd.id
   and coalesce(de.entry_id, sd.entry_id) = e.id
  order by
    e.id,
    (coalesce(e.invoice_number, de.invoice_number_verified, de.invoice_number_ocr) is null),
    (de.verified_at is null),
    de.id desc
)
select
  rr.item_family_id,
  fam.family_key,
  fam.label as family_label,
  rr.item_catalog_id,
  ic.canonical_label as catalog_label,
  rr.vendor_id,
  v.display_name as vendor_display_name,
  rr.entry_id,
  ei.invoice_number,
  rr.net_rate,
  coalesce(rr.quantity, 1) as quantity,
  round((rr.net_rate * coalesce(rr.quantity, 1))::numeric, 2) as line_amount,
  rr.observed_date,
  e.department_id,
  d.name as department_name,
  e.event_id
from public.rate_reference rr
join public.item_family fam on fam.id = rr.item_family_id
left join public.item_catalog ic on ic.id = rr.item_catalog_id
left join public.vendor v on v.id = rr.vendor_id
left join public.entries e on e.id = rr.entry_id
left join public.department d on d.id = e.department_id
left join entry_invoice ei on ei.entry_id = rr.entry_id
-- net_rate is NOT NULL on rate_reference itself (20260808000024), so the
-- only predicate this view needs is the classification one.
where rr.item_family_id is not null;

grant select on public.v_purchase_tree to authenticated;
