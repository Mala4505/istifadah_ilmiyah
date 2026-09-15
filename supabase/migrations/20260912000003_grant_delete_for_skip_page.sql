-- Completes the fix started in 20260912000002 (and, before that, in
-- 20260822000009): "permission denied for table document_extraction" when
-- skipping a page whose OCR already produced a single-page bill.
--
-- 20260808000026 §4.4c deliberately revokes DELETE on every table in public
-- from `authenticated` ("financial rows are voided, never deleted... so a
-- future accidental delete policy fails loudly instead of silently becoming
-- live"). That's a base GRANT, completely separate from a table's RLS
-- policies -- a DELETE policy only restricts which rows an operation may
-- touch; it does nothing to grant the privilege to attempt that operation at
-- all. 20260822000009 added document_extraction's DELETE policy for exactly
-- this "remove the orphaned single-page bill" feature but never re-granted
-- the privilege the base migration revoked, and 20260912000002 repeated the
-- same omission for document_extraction_line_item and
-- reconciliation_exception. Confirmed against information_schema.role_table_
-- grants: `authenticated` had no DELETE grant on any of the three, so every
-- attempt was blocked before RLS ever ran -- for every role, not just
-- whichever one happened to try it first.
--
-- entry_bill_link deliberately gets NO grant here: its deletes stay
-- RPC-only (set_bill_entry_links / remove_bill_entry_link, both security
-- definer), which is why lib/actions/review.ts's setPageSkipOverride now
-- unlinks through that RPC before deleting the bill instead of relying on
-- the ON DELETE CASCADE into entry_bill_link.
grant delete on public.document_extraction to authenticated;
grant delete on public.document_extraction_line_item to authenticated;
grant delete on public.reconciliation_exception to authenticated;
