-- Decouples admin_head and zone from department entirely (2026-09-13): the
-- venue-setup master data (42 admin heads, 13 zones) was hard-seeded under
-- department_id = 1 ('Venue Setup') from day one (20260808000005_head.sql,
-- 20260808000006_zone.sql), but entries carry their OWN department_id from
-- import classification -- completely independent of which admin head /
-- zone they're enriched with. The mismatch meant every admin-head/zone
-- dropdown that filtered by "entry's department == option's department"
-- (app/(app)/entries/[id]/page.tsx, review's Classify panel, the documents
-- attach-time prompt, the entries filter bar, and the budget-head -> admin
-- head mapping table in Settings) silently emptied for any entry not in
-- department 1. RLS itself (admin_head_select/zone_select's
-- can_see_department(department_id) gate) compounded this: a dept-role
-- staff member not assigned to department 1 saw zero admin_head/zone rows
-- at all. Admin heads and zones become plain org-wide reference data, same
-- posture as department and vendor -- no FK to department, no
-- per-department visibility gate. sub_department is untouched: it genuinely
-- belongs to one department and stays scoped that way.
--
-- Also flips admin_head/zone/sub_department/department from "seeded,
-- deny-by-default for authenticated" (20260808000026_rls_policies.sql's own
-- comment) to superadmin-editable master data, backing the Settings ->
-- Master data screen's new inline create/rename/deactivate UI.

-- ---- admin_head: drop department scoping ---------------------------------
drop policy if exists admin_head_select on public.admin_head;

-- v_admin_head_spend (latest definition: 20260908000003_entry_bill_link_
-- readers.sql) selects ah.department_id and joins department on it, so it
-- must be dropped before the column it depends on -- otherwise the DROP
-- COLUMN below fails with a dependency error. Recreated without those
-- columns near the end of this file.
drop view if exists public.v_admin_head_spend;

alter table public.admin_head drop column department_id;

-- Replaces the dropped (department_id, head_number) / (department_id, name)
-- composite uniques -- global now that there's only one namespace.
alter table public.admin_head add constraint admin_head_head_number_key unique (head_number);
alter table public.admin_head add constraint admin_head_name_key unique (name);

create policy admin_head_select on public.admin_head for select to authenticated
  using ((select private.is_staff()));

create policy admin_head_insert_superadmin on public.admin_head for insert to authenticated
  with check ((select private.is_superadmin()));

create policy admin_head_update_superadmin on public.admin_head for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));

-- ---- zone: drop department scoping ----------------------------------------
drop policy if exists zone_select on public.zone;

alter table public.zone drop column department_id;

alter table public.zone add constraint zone_zone_number_key unique (zone_number);

create policy zone_select on public.zone for select to authenticated
  using ((select private.is_staff()));

create policy zone_insert_superadmin on public.zone for insert to authenticated
  with check ((select private.is_superadmin()));

create policy zone_update_superadmin on public.zone for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));

-- ---- department: visibility unchanged (staff-wide, see the JUDGEMENT CALL
-- in 20260808000026); now superadmin-editable ------------------------------
create policy department_insert_superadmin on public.department for insert to authenticated
  with check ((select private.is_superadmin()));

create policy department_update_superadmin on public.department for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));

-- ---- sub_department: visibility unchanged (can_see_department-gated, still
-- department-scoped); now superadmin-editable ------------------------------
create policy sub_department_insert_superadmin on public.sub_department for insert to authenticated
  with check ((select private.is_superadmin()));

create policy sub_department_update_superadmin on public.sub_department for update to authenticated
  using ((select private.is_superadmin()))
  with check ((select private.is_superadmin()));

-- ---- v_admin_head_spend: recreate without the now-dropped department
-- columns (dropped further up, before the column itself was dropped) -------
create view public.v_admin_head_spend with (security_invoker = true) as
  select ah.id as admin_head_id,
    ah.name as admin_head_name,
    e.event_id,
    count(e.id) as entry_count,
    coalesce(sum(e.amount), 0::numeric) as total_amount,
    count(distinct ebl.entry_id) as entries_with_documents,
        case
            when count(e.id) = 0 then null::numeric
            else round(count(distinct ebl.entry_id)::numeric / count(e.id)::numeric * 100::numeric, 2)
        end as document_coverage_pct
   from public.admin_head ah
     left join public.entries e on e.admin_head_id = ah.id and e.is_void = false
     left join public.entry_bill_link ebl on ebl.entry_id = e.id
  group by ah.id, ah.name, e.event_id;

grant select on public.v_admin_head_spend to authenticated;
