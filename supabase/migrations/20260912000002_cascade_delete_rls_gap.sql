-- Fixes a real "can't skip this page" failure reported against a superadmin
-- account: setPageSkipOverride (lib/actions/review.ts, skip: true branch)
-- deletes the single-page bill a page already produced so the review queue
-- doesn't keep showing it. 20260822000009 added the DELETE policy for
-- document_extraction itself and assumed, in its own comment, that
-- document_extraction_line_item and reconciliation_exception "already
-- cascade-delete off document_extraction_id... without a separate policy" --
-- that assumption is wrong. Postgres enforces RLS on rows a foreign-key
-- ON DELETE CASCADE removes from a referencing table exactly as if that
-- table's own DELETE had been issued directly, and neither table has ever
-- had a DELETE policy for `authenticated` (confirmed against pg_policies --
-- SELECT/UPDATE/INSERT only on both). So the cascade removal fails with a
-- plain "permission denied for table document_extraction_line_item", which
-- lib/friendly-error.ts's `permission denied` rule then turns into "You
-- don't have permission to do this -- it may belong to another department,
-- or need a reviewer or admin account" -- read by whoever hits it as a role
-- problem, but it fires identically for admin and superadmin alike; it just
-- happened to be a superadmin who hit a single-page bill with line items
-- first. No role check was actually excluding superadmin anywhere in the
-- review code or in is_reviewer_or_admin()/can_see_source_document() (both
-- already grant superadmin full access) -- this was the one real gap.
--
-- Predicates mirror each table's existing UPDATE policy exactly (same file,
-- 20260808000026): document_extraction_line_item stays scoped via
-- can_see_document_extraction(document_extraction_id); reconciliation_exception
-- stays unscoped (deliberate -- see that migration's "staff-wide read" note),
-- reviewer-or-admin only.
create policy document_extraction_line_item_delete on public.document_extraction_line_item
  for delete
  to authenticated
  using (
    (select private.is_reviewer_or_admin())
    and (select private.can_see_document_extraction(document_extraction_id))
  );

create policy reconciliation_exception_delete on public.reconciliation_exception
  for delete
  to authenticated
  using ((select private.is_reviewer_or_admin()));
