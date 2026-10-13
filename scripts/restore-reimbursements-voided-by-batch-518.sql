-- Restore the 25 reimbursements that scrape batch 518 (2026-10-12 08:54 UTC)
-- auto-voided by mistake.
--
-- That scrape carried 377 rows but only 352 different UBBL numbers: the portal
-- list repeated 25 rows across pages and left 25 others out. The 05:03 UTC
-- scrape the same morning had all 377, and the Dept-module export taken at
-- 09:03 UTC still lists 24 of them (the 25th, RG-260929001, is Not Verified,
-- which the export never lists). So they were never deleted on the portal.
--
-- A later scrape does NOT bring them back by itself: the importer only looks
-- up entries with is_void = false.
--
-- Check first (expect 25 rows, Rs 2,47,982 in total):
--   select ubbl_number, amount, status_raw from public.entries
--    where is_void and void_note like 'Auto-voided:%(batch 518).';

begin;

update public.entries
   set is_void    = false,
       void_note  = null,
       updated_at = now()
 where type = 'reimbursement'
   and is_void = true
   and void_note like 'Auto-voided:%(batch 518).';

-- Expect: UPDATE 25. If it is anything else, run "rollback;" instead of commit.
commit;
