-- Phase 4 (docs/event-scoping-and-review-fixes-plan.md §2.5): manual page
-- skip/unskip needs to distinguish a human override from the model's own
-- classification verdict -- both write the same is_financial_document/
-- skip_reason columns (§2.5's "OCR a page the model skipped" round-trips
-- through the exact same columns a fresh model read would produce), so a
-- provenance column is the only way the UI can show "you marked this" vs
-- "the model classified this" without a second table.
alter table public.document_page
  add column skip_source text not null default 'model' check (skip_source in ('model', 'manual')),
  add column manually_set_by uuid references auth.users(id),
  add column manually_set_at timestamptz;

-- 'manual': a human skip with no model-provided reason (e.g. "not a bill,
-- just a routing note"). Building on the CURRENT eight-value list from
-- 20260814000002 (not the original five from 20260808000019) -- a live
-- query against document_page.skip_reason turned up 'permission_letter' and
-- 'photo' rows that a stale copy of this constraint would have silently
-- rejected on the next classification write.
alter table public.document_page drop constraint document_page_skip_reason_check;
alter table public.document_page add constraint document_page_skip_reason_check
  check (skip_reason is null or skip_reason in (
    'bank_cheque', 'passbook', 'unrelated_document', 'blank', 'other',
    'permission_letter', 'agreement', 'photo', 'manual'));
