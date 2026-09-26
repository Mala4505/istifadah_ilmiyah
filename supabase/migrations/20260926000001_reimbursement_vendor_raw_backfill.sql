-- Backfills entries.vendor_raw / vendor_id for every existing reimbursement
-- row from reimbursement_detail.reimburse_to_raw / reimburse_to_vendor_id.
--
-- Reimburse To IS the vendor for the reimbursement tab -- it just used to be
-- written only to reimbursement_detail, leaving entries.vendor_raw/vendor_id
-- null for every reimbursement entry ever imported. That made reimbursement
-- spend invisible to anything that identifies a transaction by vendor (found
-- 2026-09-26: several genuine, correctly-recorded reimbursements read as
-- "missing" purely because the vendor field used to look them up was blank,
-- not because the money wasn't there). The importer itself is fixed in the
-- same change (lib/import/run-portal-import.ts) so future scrapes populate
-- this directly; this migration is the one-time catch-up for rows already in
-- the table.
--
-- Guarded on vendor_raw is null so this only ever fills a blank, never
-- overwrites a value that somehow already got set.
update public.entries e
   set vendor_raw = rd.reimburse_to_raw,
       vendor_id  = rd.reimburse_to_vendor_id
  from public.reimbursement_detail rd
 where e.id = rd.entry_id
   and e.type = 'reimbursement'
   and e.vendor_raw is null;
