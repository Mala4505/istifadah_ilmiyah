-- Gap found in a session review of 2026-08-22's Phase 4 work (§2.5): manually
-- marking an already-extracted page "skip" (setPageSkipOverride,
-- lib/actions/review.ts) updated document_page's own display columns but
-- left the bill that page had already produced fully intact in
-- document_extraction -- it kept showing in the review queue exactly as
-- before, dimmed thumbnail notwithstanding. document_extraction had no
-- DELETE policy for `authenticated` at all (only select/update), which is
-- why the fix below has to add one before setPageSkipOverride's new
-- delete-the-orphaned-bill step can work under RLS.
--
-- Predicate copied verbatim from document_extraction_update
-- (20260808000026_rls_policies.sql): reviewer-or-admin, scoped to a
-- document this staff member can actually see. Line items
-- (document_extraction_line_item) and open exceptions
-- (reconciliation_exception) both already cascade-delete off
-- document_extraction_id, so removing a bill here cleans up both without
-- a separate policy or a separate delete statement.
create policy document_extraction_delete on public.document_extraction
  for delete
  to authenticated
  using (
    (select private.is_reviewer_or_admin())
    and (select private.can_see_source_document(document_extraction.source_document_id))
  );
