-- Checklist 5.21 (docs/import-review-ux-checklist.md Phase 5; plan §13 V1):
-- the empty-extraction state's new "Add a row" action needs a signed-in
-- reviewer to INSERT a document_extraction_line_item row directly through
-- the session-bound client (lib/actions/review.ts's new addLineItem).
--
-- 20260808000026_rls_policies.sql gave this table a select policy (staff-wide,
-- scoped by can_see_document_extraction) and an update policy
-- (reviewer/admin, for the verify-screen's per-field corrections) but no
-- insert policy at all -- every row until now was created by the OCR
-- pipeline's service-role extract job (lib/jobs/handlers/extract.ts). Same
-- shape as 20260813000003_reconciliation_exception_insert_policy.sql's
-- reasoning for that table: a single-table insert RLS can gate on its own,
-- no multi-table write or cross-department concern that would justify a
-- SECURITY DEFINER RPC. Same role gate as the existing update policy
-- (reviewer/admin, §4.4c), plus the same document-visibility scoping the
-- select/update policies already use -- a reviewer can only add a row to a
-- document_extraction they can otherwise see.
create policy document_extraction_line_item_insert on public.document_extraction_line_item for insert to authenticated
  with check ((select private.is_reviewer_or_admin())
              and (select private.can_see_document_extraction(document_extraction_id)));
