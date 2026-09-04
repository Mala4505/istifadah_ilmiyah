-- reporting-blueprint.md §8 Phase Six -- D-04 "Duplicate payment register".
--
--   D-04  "The same bill paid twice -- matched by document hash, and by
--          vendor + invoice number + amount. Reported as RUPEES PREVENTED."
--
-- ONE view here. E-03 (Vendor risk board) is deliberately composed app-side in
-- lib/reports/surfaces/duplicate-vendor-risk.ts from the existing
-- v_vendor_scorecard (20260903000006) + v_vendor_concentration
-- (20260822000011) -- every column it needs is already published per
-- (vendor, event), the top ~15 rank + cumulative-share cumulation + risk
-- banding are cheap in the loader well inside ROW_CAP, and a new view would
-- only re-join two views that already share the (vendor_id, event_id) grain.
-- See that loader's header for the risk_score weighting.
--
-- ----------------------------------------------------------------------------
-- v_duplicate_payment_register -- D-04
-- ----------------------------------------------------------------------------
-- One row per duplicate-payment CLUSTER. A "cluster" is a single
-- flags.flag_type = 'duplicate_payment' row together with the entries it ties
-- together (its anchor `entry_id` unioned with `related_entry_ids`). The
-- vendor-pattern detector (lib/analytics/rules/vendor-patterns.ts,
-- detectDuplicatePayment) emits one such flag per candidate PAIR of bills for
-- one vendor inside DUPLICATE_WINDOW_DAYS (90) -- so in practice a cluster is
-- two entries and entry_count_in_cluster = 2, but the view does not assume
-- that: it reads whatever the flag's entry set contains.
--
-- Column meanings:
--   flag_id                -- flags.id. Stable cluster identity; the row the
--                             reviewer confirms / dismisses in Compliance.
--   severity               -- flags.severity ('low'|'medium'|'high'). The
--                             detector raises 'high' on an invoice-number
--                             match, amount-band severity otherwise.
--   status                 -- flags.status ('open'|'confirmed'|'dismissed').
--                             open      = not yet reviewed
--                             confirmed = a reviewer agreed it is a duplicate
--                             dismissed = a reviewer checked and it is NOT a
--                                         duplicate (two legitimate charges)
--   vendor_id / vendor_display_name
--                          -- flags.vendor_id (always set on this flag type --
--                             it is a vendor-level detector) -> vendor.
--   department_id / department_name
--                          -- resolved from the flag's ANCHOR entry_id ->
--                             entries.department_id, exactly as
--                             v_compliance_summary does. NULL when entry_id is
--                             null or the entry is outside a
--                             department-scoped reviewer's RLS scope.
--   entry_ids (bigint[])   -- every distinct non-null entry id in the cluster
--                             (anchor entry_id UNION related_entry_ids),
--                             ascending. This is the one array-typed column;
--                             the grain stays one row per flag. It lets the
--                             section link each entry individually
--                             (/entries/<id>) without a second entry-grain
--                             query.
--   entry_count_in_cluster -- array_length(entry_ids). How many entries the
--                             flag ties together (2 for the pairwise detector).
--   match_basis            -- how the duplicate was matched, derived from
--                             flags.evidence->>'match_basis':
--                               'invoice_number' -> 'vendor + invoice number'
--                               'amount'         -> 'vendor + amount + date window'
--                               anything else / null -> 'heuristic'
--                             NOTE: the shipped detector matches on invoice
--                             number or on amount-inside-window only. The
--                             blueprint also names "document hash" matching;
--                             no detector emits that basis today, so no cluster
--                             will ever carry it until one does -- the CASE is
--                             ready for it via a future evidence value but this
--                             view invents nothing.
--   duplicate_amount       -- the rupees that would be / were paid twice.
--                             Primary source: flags.amount_at_risk, which the
--                             detector sets to min(the two bill amounts) -- i.e.
--                             exactly one duplicated payment. Fallback when
--                             amount_at_risk is null: the smallest resolved
--                             entry amount in the cluster * (resolved entry
--                             count - 1), i.e. amount * (count - 1). 0 when
--                             nothing can be resolved (all entries out of RLS
--                             scope). numeric(14,2), same scale as entries.amount.
--   first_entry_date / last_entry_date
--                          -- min / max entries.date across the RESOLVED
--                             entries in the cluster (non-void only). NULL when
--                             none resolve within the caller's RLS scope.
--   created_at             -- flags.created_at = "first seen" (the upsert keeps
--                             this stable across re-detections).
--   last_detected_at       -- flags.last_detected_at = most recent detector run
--                             that still saw this cluster.
--   event_id               -- resolved from the anchor entry_id -> entries.event_id,
--                             same as v_compliance_summary. Plain output column,
--                             NEVER filtered inside the view. NULL for a flag
--                             whose anchor entry has no event or is out of RLS
--                             scope -- the query site keeps those with
--                             `.or(event_id.eq.X,event_id.is.null)`, never a
--                             plain `.eq` (Phase 0 §0.2).
--
-- RLS / department-leak: security_invoker = true, so base-table RLS applies to
-- the caller. `flags` and `vendor` are staff-wide; `entries` is
-- department-scoped (can_see_department). A department-scoped reviewer sees
-- every duplicate-payment flag row, but for a cluster whose entries belong to
-- another department the entry-derived columns (department_id/name, event_id,
-- first/last_entry_date, and duplicate_amount when it had to fall back) read
-- null / 0 rather than erroring -- the same property v_compliance_summary
-- documents. duplicate_amount from amount_at_risk is unaffected (it lives on
-- the flag).
--
-- Brand-new object -- a plain grant is all that is needed (no drop-and-recreate,
-- nothing else here to re-grant). Not covered by the historical blanket grant
-- (20260808000026).

create view public.v_duplicate_payment_register with (security_invoker = true) as
with dup_flags as (
  select
    f.id as flag_id,
    f.severity,
    f.status,
    f.vendor_id,
    f.entry_id,
    f.amount_at_risk,
    f.evidence,
    f.created_at,
    f.last_detected_at,
    (
      select coalesce(array_agg(eid order by eid), '{}'::bigint[])
      from (
        select distinct eid
        from (
          select unnest(coalesce(f.related_entry_ids, '{}'::bigint[])) as eid
          union all
          select f.entry_id
        ) raw
        where eid is not null
      ) uniq
    ) as entry_ids
  from public.flags f
  where f.flag_type = 'duplicate_payment'
),
cluster_entry_facts as (
  select
    df.flag_id,
    min(e.date) as first_entry_date,
    max(e.date) as last_entry_date,
    count(e.id) as resolved_entry_count,
    min(e.amount) as min_resolved_amount
  from dup_flags df
  left join public.entries e
    on e.id = any(df.entry_ids)
   and e.is_void = false
  group by df.flag_id
)
select
  df.flag_id,
  df.severity,
  df.status,
  df.vendor_id,
  v.display_name as vendor_display_name,
  anchor.department_id,
  d.name as department_name,
  df.entry_ids,
  coalesce(array_length(df.entry_ids, 1), 0) as entry_count_in_cluster,
  case df.evidence->>'match_basis'
    when 'invoice_number' then 'vendor + invoice number'
    when 'amount' then 'vendor + amount + date window'
    when 'document_hash' then 'document hash'
    else 'heuristic'
  end as match_basis,
  coalesce(
    df.amount_at_risk,
    greatest(cef.min_resolved_amount * (nullif(cef.resolved_entry_count, 0) - 1), 0)
  )::numeric(14,2) as duplicate_amount,
  cef.first_entry_date,
  cef.last_entry_date,
  df.created_at,
  df.last_detected_at,
  anchor.event_id
from dup_flags df
left join cluster_entry_facts cef on cef.flag_id = df.flag_id
left join public.entries anchor on anchor.id = df.entry_id
left join public.department d on d.id = anchor.department_id
left join public.vendor v on v.id = df.vendor_id;

grant select on public.v_duplicate_payment_register to authenticated;
