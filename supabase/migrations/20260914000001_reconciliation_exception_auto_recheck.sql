-- Recalculate-on-save (2026-09-14, user request): "can it recalculate that
-- flag on that bill and see if it's still flagged or not?" -- followed by a
-- decision on how to treat what the recheck finds: for exception types where
-- the finding IS an amount discrepancy (line_item_tally_mismatch,
-- line_item_row_math_mismatch, ocr_total_vs_amount), a passing recheck must
-- never silently flip `status` to resolved -- money-shaped findings still
-- need a human's eyes and a note (this table's existing "resolved with no
-- reason is not an audit trail" rule, enforced by lib/actions/exceptions.ts,
-- governs those regardless of how confident the recheck is). Everything else
-- recomputable at save time (the GSTIN checksum/own-org checks) already
-- auto-resolves outright in lib/actions/review.ts -- unchanged by this
-- migration.
--
-- These two columns let saveVerification stamp "the recheck came back clean"
-- without touching status: `auto_recheck_cleared_at` marks that it happened,
-- `auto_recheck_note` is pre-filled resolution-note text so the reviewer's
-- job is a single confirming click, not retyping why. Both stay null until a
-- recheck actually clears the row, and both go stale (irrelevant, but
-- harmless) once the row is actually resolved/dismissed.
alter table public.reconciliation_exception
  add column auto_recheck_note text,
  add column auto_recheck_cleared_at timestamptz;
