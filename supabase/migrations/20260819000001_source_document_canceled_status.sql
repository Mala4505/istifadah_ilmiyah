-- Adds 'canceled' to source_document.match_status (documents inbox: "cancel tracking"
-- lets staff pull a document out of the inbox at any stage -- while it's still
-- uploading/queued/extracting, or after a failed/successful extraction -- without
-- pretending it never existed. Same non-destructive pattern as every other table here
-- (§4.4d, "financial rows are voided, never removed"; `revoke delete on all tables`,
-- 20260808000026): the row and its extraction/pages/run history all stay, only
-- match_status flips, and the existing `.in('match_status', ['unmatched','suggested'])`
-- filter on the inbox page and dashboard count (app/(app)/documents/page.tsx,
-- app/(app)/page.tsx) already excludes anything outside those two values, so a
-- canceled document disappears from the inbox for free -- no query changes needed.
alter table public.source_document drop constraint source_document_match_status_check;
alter table public.source_document add constraint source_document_match_status_check
  check (match_status in ('unmatched','suggested','matched','no_entry_expected','canceled'));
