-- docs/pre-deploy-findings-and-plan.md §10.3: no skip reason exists for an ID document
-- (PAN card, Aadhaar, and similar) -- the user named PAN cards first when describing
-- skippable pages, and today they fall into the catch-all 'other' bucket, indistinguishable
-- from a genuinely unclassifiable page in the reviewer's thumbnail rail.
--
-- The doc's explicit warning: build the new constraint from the LIVE constraint definition,
-- not from the original CREATE TABLE -- a naive rebuild silently drops values added by
-- later migrations. 20260822000004 hit exactly this trap once already: it rebuilt
-- document_page_skip_reason_check from a STALE five-value copy, and its own header notes
-- "a live query against document_page.skip_reason turned up 'permission_letter' and
-- 'photo' rows that a stale copy of this constraint would have silently rejected on the
-- next classification write." Tracing every migration that has touched this constraint
-- (full grep of supabase/migrations/ for `skip_reason`, not just the most recent hit):
--
--   20260808000019_document_page.sql      (original)      bank_cheque, passbook,
--                                                          unrelated_document, blank, other
--   20260814000002_instrument_type_and_tax.sql  (+3)       + permission_letter, agreement,
--                                                            photo
--   20260822000004_page_scoped_reextraction.sql (+1)       + manual
--
-- Union of every value ever added, and the current live set: bank_cheque, passbook,
-- unrelated_document, blank, other, permission_letter, agreement, photo, manual (nine
-- values -- matches docs/pre-deploy-findings-and-plan.md's list, verified against
-- migration history rather than trusted from the doc alone, per its own instruction).
-- No migration after 20260822000004 touches this constraint (confirmed by the same grep),
-- so that is the correct base to widen.
alter table public.document_page drop constraint document_page_skip_reason_check;
alter table public.document_page add constraint document_page_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'bank_cheque', 'passbook', 'unrelated_document', 'blank', 'other',
    'permission_letter', 'agreement', 'photo', 'manual', 'id_document'));
