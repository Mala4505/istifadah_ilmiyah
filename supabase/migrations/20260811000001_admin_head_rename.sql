-- Renamed from `head` to `admin_head` (confirmed 2026-08-11, MASTER-PLAN §3.1) purely
-- to stop colliding with "budget head" in conversation. Content unchanged: still the
-- 42 granular Venue-Setup expense items from master.xlsx.
--
-- A table rename carries everything with it -- RLS policies (head_select,
-- 20260808000026), indexes, and every FK pointing at it (budget_head.head_id,
-- entries.head_id, renamed to entries.admin_head_id below) all follow automatically
-- because Postgres tracks them by OID, not by name. Nothing else needs restating here.
alter table public.head rename to admin_head;
alter index head_department_idx rename to admin_head_department_idx;
alter policy head_select on public.admin_head rename to admin_head_select;
