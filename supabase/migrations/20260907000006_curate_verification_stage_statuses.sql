-- Curate the "Verification stage" statuses into the entry_status vocabulary
-- and renumber sort_order into one coherent sequence (operator decision,
-- 2026-09-07).
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- resolveStatus (lib/import/run-import.ts) auto-inserts any status code an
-- import meets for the first time with sort_order = 999 and raises a
-- low-severity unknown_status_code exception, precisely so a human can give
-- the new word a real position once its meaning is known. This is the
-- designed follow-up to that stub -- the same step 20260814000008 took for
-- the two Audit-portal statuses.
--
-- The Departmental portal has now sent "Verification stage 1",
-- "Verification stage 2" and "Verification Stage 4"; all three were sitting
-- at sort_order 999. Stage 3 has not been seen yet but obviously belongs in
-- the sequence, so it is created here too -- slug verification_stage_3,
-- matching lib/import/portal-mapping.ts's slugifyStatus, so a future import
-- that renders "Verification stage 3" resolves to this row instead of
-- auto-inserting another 999 stub and raising a fresh exception.
--
-- ORDER (operator's, 2026-09-07): the verification stages are a late
-- departmental review step that sits just before the Main-side 'approved'.
-- The whole vocabulary is renumbered 1..13 in one pass because the
-- pre-unification numbers overlapped ('pending' and 'approved' were both
-- sort_order 1; 20260828000001 dropped the source_system column that used to
-- keep those two scales apart) and every status auto-inserted since sat at
-- 999 -- so nothing actually sorted "just before approved".
--
-- Final order: pending, sent_main, good_for_submission, subject_to_approval,
-- not_verified, received, verification_stage_1..4, approved,
-- tax_invoice_upload_pending_paid, paid.
-- ---------------------------------------------------------------------------

begin;

-- ---- 1. the verification-stage vocabulary (upsert) -----------------------
-- INSERT (not just UPDATE) so a freshly-seeded database gets these real,
-- confirmed statuses too -- same posture as 20260814000008. Labels use the
-- portal's own wording ("Verification stage N", lowercase s), which also
-- normalises the initcap-fallback label "Verification Stage 4" that the
-- auto-insert path had given the stage-4 row.
insert into public.entry_status (code, label, sort_order, is_terminal) values
  ('verification_stage_1', 'Verification stage 1', 7,  false),
  ('verification_stage_2', 'Verification stage 2', 8,  false),
  ('verification_stage_3', 'Verification stage 3', 9,  false),
  ('verification_stage_4', 'Verification stage 4', 10, false)
on conflict (code) do update
  set label       = excluded.label,
      sort_order  = excluded.sort_order,
      is_terminal = excluded.is_terminal;

-- ---- 2. renumber the rest of the vocabulary into the same sequence -------
-- UPDATE-only: these rows come either from seed.sql ('pending', 'sent_main',
-- 'approved') or from a live import's auto-insert ('good_for_submission' and
-- friends). On a fresh database the import-only codes don't exist yet, so
-- their rows here are harmless no-ops; in production they move off 999 into
-- place. Labels are left untouched.
update public.entry_status s
   set sort_order = v.sort_order
  from (values
    ('pending',                         1),
    ('sent_main',                       2),
    ('good_for_submission',             3),
    ('subject_to_approval',             4),
    ('not_verified',                    5),
    ('received',                        6),
    ('approved',                        11),
    ('tax_invoice_upload_pending_paid', 12),
    ('paid',                            13)
  ) as v(code, sort_order)
 where s.code = v.code;

-- ---- 3. close the verification-stage exceptions -------------------------
-- Stages 1 and 2 have open unknown_status_code exceptions; stage 4 never
-- raised one and stage 3 is new. The still-open exceptions for
-- not_verified / received / subject_to_approval / tax_invoice_upload_pending_paid
-- are deliberately left open -- those rows got a real sort_order above but a
-- full triage of them was out of scope for this pass.
update public.reconciliation_exception
   set status = 'resolved',
       resolution_note = 'Given a curated label and sort_order -- see 20260907000006_curate_verification_stage_statuses.sql.',
       resolved_at = now()
 where status = 'open'
   and exception_type = 'unknown_status_code'
   and dedup_key in (
     'unknown_status_code:verification_stage_1',
     'unknown_status_code:verification_stage_2'
   );

commit;
