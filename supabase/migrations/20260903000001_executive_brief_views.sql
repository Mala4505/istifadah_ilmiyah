-- reporting-blueprint.md §8 Phase Two: views for E-01 (department league table),
-- E-02 (attention map), A-03 (burn rate & landing forecast) and A-04 (admin-head
-- accountability). A-03's per-department burn/pace math is deliberately NOT a SQL
-- view -- lib/reports/hero-metrics.ts already computes this exact shape
-- (computeSpendTrend: weekly cumulative actual vs. even-pace target, keyed off
-- event.starts_on/ends_on) at the whole-event grain, entirely in TS from raw
-- `entries` rows. The Phase Two loader re-runs that same function per department
-- by filtering entryRows first, rather than duplicating the pace math in SQL --
-- so A-03 needs no new view here, only the two below that E-01/E-02 also need.
--
-- Three new views, all department- or admin-head-grained, all event-scoped as a
-- plain output column (filtering happens at the query site, per every view in
-- 20260822000007/20260822000011/20260814000007):
--
--   v_department_documentation_coverage -- per (department, event): entry count,
--     documented-entry count, coverage %. Same formula as v_vendor_spend's
--     document_coverage_pct (20260811000004), re-grained to department. Grouped
--     directly off `entries` (not left-joined from `department`) because every
--     group here is built from at least one entry row, so entry_count can never
--     be zero within a group -- unlike v_vendor_spend, which left-joins from
--     `vendor` and can have a zero-entry vendor, no null-guard is needed on the
--     division.
--
--   v_department_risk_summary -- per (department, event): open ₹ at risk and
--     open issue count, unioning `flags` and `reconciliation_exception` (both
--     already amount_at_risk/status-shaped per 20260808000023/20260808000025)
--     the same way v_open_issues does, then resolving department strictly via
--     `entries.department_id`. Like v_open_issues/v_compliance_summary, a
--     vendor-level flag or batch-level exception with a null entry_id has no
--     department to attribute to and is excluded here -- consistent with the
--     limitation both of those views already document, not a new one.
--
--   v_admin_head_spend -- per (admin_head, event): spend, entry count, document
--     coverage. Mirrors v_vendor_spend's grain and shape exactly (LEFT JOIN from
--     admin_head so a head with zero entries this event still appears, with a
--     null event_id row). Carries department_id/department_name too: admin_head
--     has no budget allocation of its own (only budget_head/department/
--     sub_department do -- there is no FK from admin_head to budget_head), so
--     A-04's "budget adherence" column is sourced app-side by attributing the
--     admin head's owning department's budget adherence
--     (v_department_budget_vs_actual) as contextual accountability, not a
--     literal per-head budget the schema has no way to represent.
--
-- security_invoker = true on all three (every view in this codebase runs as the
-- calling user so RLS on the base tables applies); each is a new object the
-- broad `grant select on all tables in schema public` (20260808000026) predates,
-- so each needs its own explicit grant.

create view public.v_department_documentation_coverage with (security_invoker = true) as
select
  e.department_id,
  d.name as department_name,
  e.event_id,
  count(e.id) as entry_count,
  count(distinct sd.entry_id) as entries_with_documents,
  round(count(distinct sd.entry_id)::numeric / count(e.id) * 100, 2) as document_coverage_pct
from public.entries e
join public.department d on d.id = e.department_id
left join public.source_document sd on sd.entry_id = e.id
where e.is_void = false and e.department_id is not null
group by e.department_id, d.name, e.event_id;

create view public.v_department_risk_summary with (security_invoker = true) as
select
  e.department_id,
  d.name as department_name,
  e.event_id,
  count(*) as open_issue_count,
  sum(combined.amount_at_risk) as amount_at_risk
from (
  select re.entry_id, re.amount_at_risk
  from public.reconciliation_exception re
  where re.status = 'open'
  union all
  select f.entry_id, f.amount_at_risk
  from public.flags f
  where f.status = 'open'
) combined
join public.entries e on e.id = combined.entry_id
join public.department d on d.id = e.department_id
where e.department_id is not null
group by e.department_id, d.name, e.event_id;

create view public.v_admin_head_spend with (security_invoker = true) as
select
  ah.id as admin_head_id,
  ah.name as admin_head_name,
  ah.department_id,
  d.name as department_name,
  e.event_id,
  count(e.id) as entry_count,
  coalesce(sum(e.amount), 0) as total_amount,
  count(distinct sd.entry_id) as entries_with_documents,
  case when count(e.id) = 0 then null
       else round(count(distinct sd.entry_id)::numeric / count(e.id) * 100, 2)
  end as document_coverage_pct
from public.admin_head ah
join public.department d on d.id = ah.department_id
left join public.entries e on e.admin_head_id = ah.id and e.is_void = false
left join public.source_document sd on sd.entry_id = e.id
group by ah.id, ah.name, ah.department_id, d.name, e.event_id;

grant select on
  public.v_department_documentation_coverage,
  public.v_department_risk_summary,
  public.v_admin_head_spend
to authenticated;
