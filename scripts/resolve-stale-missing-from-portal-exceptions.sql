-- One-off cleanup (2026-10-09): resolve stale `departmental_entry_missing_from_portal`
-- exceptions.
--
-- These were raised 2026-09-19..22, before detectMissingDepartmentalEntries
-- (lib/import/run-portal-import.ts) switched from "flag for review" to
-- "auto-void". Since then every full departmental scrape voids any entry it no
-- longer sees, so an entry that is still non-void AND was written by a scrape
-- after the exception was raised is demonstrably still on the portal: the
-- exception is a false alarm. Nothing else revisits them, so they sat open
-- forever (324 open on 2026-10-09, 323 of them matching this rule).
--
-- Reversible: every row touched carries the resolution_note below, so
--   update public.reconciliation_exception
--      set status = 'open', resolution_note = null, resolved_at = null
--    where resolution_note like 'Stale: entry seen again in portal scrape batch %';
-- puts them back.

update public.reconciliation_exception x
   set status          = 'resolved',
       resolution_note = 'Stale: entry seen again in portal scrape batch ' || e.import_batch_id
                         || ' after this was raised; auto-void would have removed it if it were gone.',
       resolved_at     = now()
  from public.entries e
  join public.import_batch ib on ib.id = e.import_batch_id
 where x.entry_id = e.id
   and x.exception_type = 'departmental_entry_missing_from_portal'
   and x.status = 'open'
   and e.is_void = false
   and ib.started_at > x.created_at
returning x.id;
