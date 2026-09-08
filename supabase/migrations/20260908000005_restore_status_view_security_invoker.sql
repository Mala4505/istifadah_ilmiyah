-- Restore security_invoker on the three status/enrichment views that
-- 20260828000001_unify_entry_status.sql silently un-set.
--
-- That migration recreated v_entry_enriched, v_department_audit_variance and
-- v_entry_status_counts with a bare `create view public.<name> as ...` (no
-- `with (security_invoker = true)`). A CREATE OR REPLACE VIEW without a WITH
-- clause RESETS the view's reloptions, so all three dropped back to
-- security_invoker = false and have been running with the view OWNER's rights
-- ever since (2026-08-28) -- meaning entries_select / can_see_department is NOT
-- applied when a non-superuser role reads them, and every authenticated user
-- (including a DEACTIVATED one) sees every department's entries through them.
--
-- (20260901000002 recreated v_entry_status_counts again, also without the flag.)
--
-- The live RLS integration suite (test/integration/rls.test.ts) asserts exactly
-- this scoping on v_entry_enriched, but has been red at fixture setup since
-- entries.event_id went NOT NULL (20260822000005), so the regression went
-- unnoticed. This migration is a pure reloption flip -- no view body changes.

alter view public.v_entry_enriched            set (security_invoker = true);
alter view public.v_department_audit_variance set (security_invoker = true);
alter view public.v_entry_status_counts       set (security_invoker = true);
