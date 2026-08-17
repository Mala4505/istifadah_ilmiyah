-- Dashboard status-count summary (docs/hub-refinements-plan.md §0 item 3).
-- Every entry carries three independent status fields -- Status, Audit
-- status, Hub status (§2 of that plan) -- and the Dashboard needs "how many
-- entries sit at each value of each dimension" for all three. This view does
-- the GROUP BY once, server-side (one query per dimension, UNION ALL'd),
-- rather than the client fetching raw rows and tallying them in JS.
--
-- security_invoker = true: same RLS-scoping convention as every other
-- reporting view (20260808000028_reporting_views.sql) -- a department-scoped
-- viewer only ever sees counts for the departments they can see, because the
-- underlying `entries` RLS policy (§4.2 entries_select) applies exactly as if
-- this were a direct query.
--
-- Deliberately NOT filtered on is_void: components/entries (the list this
-- view's counts link out to via /entries?st=/ast=/hs=) applies no is_void
-- filter of its own -- see components/entries/query.ts's applyEntriesFilters,
-- which has no is_void branch. Filtering void entries out here while the
-- list still shows them would make a tile's count and its destination
-- disagree.
--
-- status_id / audit_status_id are nullable (entries.status_id, no NOT NULL --
-- see 20260808000013_entries.sql / 20260811000003_entries_restructure.sql),
-- so a null value surfaces here as a synthetic 'not_set' row per dimension
-- rather than being silently dropped from the count. hub_status_id is `not
-- null default 1`, and id=1 already IS the real 'not_set' hub_status row
-- (20260808000010_hub_status.sql), so no synthetic row is needed for that
-- dimension -- every entry already resolves to a real hub_status.
create view public.v_entry_status_counts with (security_invoker = true) as
select
  'status'::text as dimension,
  e.status_id,
  coalesce(st.code, 'not_set') as status_code,
  coalesce(st.label, 'Not set') as status_label,
  coalesce(st.sort_order, 999) as sort_order,
  count(*) as entry_count
from public.entries e
left join public.entry_status st on st.id = e.status_id
group by e.status_id, st.code, st.label, st.sort_order
union all
select
  'audit_status'::text as dimension,
  e.audit_status_id,
  coalesce(ast.code, 'not_set') as status_code,
  coalesce(ast.label, 'Not set') as status_label,
  coalesce(ast.sort_order, 999) as sort_order,
  count(*) as entry_count
from public.entries e
left join public.entry_status ast on ast.id = e.audit_status_id
group by e.audit_status_id, ast.code, ast.label, ast.sort_order
union all
select
  'hub_status'::text as dimension,
  e.hub_status_id,
  hs.code as status_code,
  hs.label as status_label,
  hs.sort_order,
  count(*) as entry_count
from public.entries e
join public.hub_status hs on hs.id = e.hub_status_id
group by e.hub_status_id, hs.code, hs.label, hs.sort_order;

-- A view is its own object, distinct from its base tables -- the broad
-- `grant select ... on all tables in schema public` in
-- 20260808000026_rls_policies.sql ran *before* this view existed, so it does
-- not cover it. Without an explicit grant here, PostgREST would return
-- "permission denied" even though security_invoker RLS would otherwise allow
-- the rows (same reasoning as the grant block in 20260808000028_reporting_views.sql).
grant select on public.v_entry_status_counts to authenticated;
