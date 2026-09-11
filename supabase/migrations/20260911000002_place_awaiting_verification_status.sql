-- Give "awaiting_verification" (first seen from the Departmental portal in
-- batch #102, 2026-09-11) a real position instead of the auto-inserted
-- sort_order = 999 stub -- the designed follow-up to resolveStatus's
-- unknown_status_code exception (lib/import/run-import.ts), same posture as
-- 20260814000008 and 20260907000006.
--
-- ORDER (operator's, 2026-09-11): sits immediately before 'not_verified' --
-- the only other status naming "verified" in the vocabulary -- so a row is
-- 'awaiting_verification' first and only becomes 'not_verified' once the
-- portal actually renders that verdict.
--
-- Current sequence (20260907000006): pending(1), sent_main(2),
-- good_for_submission(3), subject_to_approval(4), not_verified(5),
-- received(6), verification_stage_1..4(7-10), approved(11),
-- tax_invoice_upload_pending_paid(12), paid(13).
--
-- New sequence: pending(1), sent_main(2), good_for_submission(3),
-- subject_to_approval(4), awaiting_verification(5), not_verified(6),
-- received(7), verification_stage_1..4(8-11), approved(12),
-- tax_invoice_upload_pending_paid(13), paid(14).

begin;

-- ---- 1. shift everything from not_verified onward up by one --------------
update public.entry_status s
   set sort_order = v.sort_order
  from (values
    ('not_verified',                    6),
    ('received',                        7),
    ('verification_stage_1',            8),
    ('verification_stage_2',            9),
    ('verification_stage_3',            10),
    ('verification_stage_4',            11),
    ('approved',                        12),
    ('tax_invoice_upload_pending_paid', 13),
    ('paid',                            14)
  ) as v(code, sort_order)
 where s.code = v.code;

-- ---- 2. place awaiting_verification at 5 ----------------------------------
-- UPDATE-only, matching 20260907000006's posture for auto-inserted codes:
-- this row already exists (created by batch #102's auto-insert) with the
-- portal's own rendered label carried across as displayLabel, so only the
-- ordering needs fixing here.
update public.entry_status
   set sort_order = 5
 where code = 'awaiting_verification';

-- ---- 3. close the exception this auto-insert raised -----------------------
update public.reconciliation_exception
   set status = 'resolved',
       resolution_note = 'Given a sort_order -- see 20260911000002_place_awaiting_verification_status.sql.',
       resolved_at = now()
 where status = 'open'
   and exception_type = 'unknown_status_code'
   and dedup_key = 'unknown_status_code:awaiting_verification';

commit;
