-- Give the two real Audit-portal statuses (confirmed live 2026-08-14 via the
-- bookmarklet scrape, §17.23) proper labels and ordering instead of the
-- auto-inserted sort_order = 999 stub every unseen status code gets on first
-- sight (lib/import/run-import.ts's resolveStatus). This is the designed
-- next step for that stub, not a workaround: an unseen code raises a
-- low-severity unknown_status_code exception specifically so a human can do
-- this once its meaning is known.
--
-- Ordering, relative to the existing 'approved' (source_system 'audit',
-- sort_order 1, is_terminal true -- 20260808000009/seed.sql): the portal's
-- own status wording -- "Tax Invoice Upload Pending (Paid)" -- says payment
-- has already gone out and the tax invoice is the one thing outstanding, so
-- it sits after 'approved' and before the terminal 'paid'.
insert into public.entry_status (code, label, source_system, sort_order, is_terminal)
values
  ('tax_invoice_upload_pending_paid', 'Tax Invoice Upload Pending (Paid)', 'audit', 2, false),
  ('paid',                            'Paid',                             'audit', 3, true)
on conflict (code, source_system) do update
  set label = excluded.label,
      sort_order = excluded.sort_order,
      is_terminal = excluded.is_terminal;

-- Close out the auto-inserted exception for these two codes, if a commit
-- already hit the auto-insert path before this migration landed. The dry
-- run described in chat rolled its own insert back (§3.6's "dry_run: roll
-- every row-level write back"), so this is a no-op in that case, not a
-- guess that one exists.
update public.reconciliation_exception
   set status = 'resolved',
       resolution_note = 'Given a proper label and sort_order -- see 20260814000008_audit_status_labels.sql.',
       resolved_at = now()
 where status = 'open'
   and exception_type = 'unknown_status_code'
   and dedup_key in (
     'unknown_status_code:tax_invoice_upload_pending_paid:audit',
     'unknown_status_code:paid:audit'
   );
