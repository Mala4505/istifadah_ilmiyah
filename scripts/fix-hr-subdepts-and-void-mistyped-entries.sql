-- 2026-10-09 data cleanup, requested by the user.
--
-- 1) Un-garble the 3 "HR (B) / KG Khidmat Takhmeen" sub-departments (ids 259-261).
--    They were stored as 'B) / KG Khidmat Takhmeen (Accommodation' etc. — the
--    department name contains brackets, and the label was split on the wrong one.
--    Entry 18248 is a 'Printing & Stationery' entry that was sitting on the
--    'Accommodation' sub-department (259); move it to 260 so the rename does not
--    leave it mis-classified.
-- 2) Void 16 Not Verified entries (total Rs 27,72,355) that were typed wrongly and re-entered under a new
--    UBBL (confirmed by the user 2026-10-09). Same effect as voidEntries()
--    (lib/actions/entries.ts): is_void + void_note, and any open
--    departmental_entry_missing_from_portal exception is resolved.

begin;

update public.sub_department set name = 'Accommodation'          where id = 259 and department_id = 599;
update public.sub_department set name = 'Printing & Stationery'  where id = 260 and department_id = 599;
update public.sub_department set name = 'Transport/Travelling'   where id = 261 and department_id = 599;

update public.entries set sub_department_id = 260 where id = 18248 and sub_department_id = 259;

with voided as (
  update public.entries
     set is_void    = true,
         void_note  = 'Voided: mistyped entry, re-entered by the department under a corrected UBBL (confirmed 2026-10-09).',
         updated_at = now()
   -- the 16 rows in the user's Main-portal screenshot (all Not Verified), matched by Main number
   where main_number in ('2026100265','202610036','2026100314','2026100313','2026100312',
                         '2026092826','2026092852','2026092540','2026092539','20260925105',
                         '2026092274','2026092235','20260916244','202609156','202608285','2026081241')
     and is_void = false
     and status_raw = 'Not Verified'
  returning id
)
update public.reconciliation_exception
   set status = 'resolved',
       resolution_note = 'Entry voided: mistyped, re-entered under a corrected UBBL (2026-10-09).',
       resolved_at = now()
 where exception_type = 'departmental_entry_missing_from_portal'
   and status = 'open'
   and entry_id in (select id from voided);

commit;

select 'subdepts' k, id::text, name from public.sub_department where id in (259,260,261)
union all
select 'voided', ubbl_number, amount::text from public.entries where is_void and void_note like 'Voided: mistyped entry%';
