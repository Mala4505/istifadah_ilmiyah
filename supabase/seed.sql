-- Foundational reference data (Phase 1A Day 1). Order matters:
--   1. department first -- head/zone FK to it.
--   2. head (42 rows) / zone (13 rows), verbatim from master.xlsx.
--   3. entry_status -- observed values only, not the superseded v1 guesses (§3.3).
--   4. hub_status -- inserted in this exact order so id=1 resolves to 'not_set',
--      matching public.entries.hub_status_id's `default 1`
--      (20260808000013_entries.sql).
--
-- Assumes a fresh project: identity columns start at 1, so department_id = 1 below is
-- reliable on first run.

insert into public.department (name) values ('Venue Setup');

insert into public.head (department_id, head_number, name) values
  (1, 1,  'NAZARUL MAKAM {AS}'),
  (1, 2,  'DOMES'),
  (1, 3,  'WATERPROOF MANDAP {PERIPHERY}'),
  (1, 4,  'RENTS'),
  (1, 5,  'CARPET + HITLON'),
  (1, 6,  'GEB/TORENT DEPOSIT'),
  (1, 7,  'SUB STATION CONSTRUCTION'),
  (1, 8,  'EXPENSE FOR ADDITIONAL POWER'),
  (1, 9,  'ELECTRICITY CONSUMPTION'),
  (1, 10, 'ELECTRICAL REPAIRS'),
  (1, 11, 'GENERATOR RENT'),
  (1, 12, 'DIESEL'),
  (1, 13, 'OPERATOR FOR GENERATOR'),
  (1, 14, 'AIR CONDITIONER'),
  (1, 15, 'SECURITY'),
  (1, 16, 'CCTV'),
  (1, 17, 'LIGHTING'),
  (1, 18, 'LEVELLING'),
  (1, 19, 'ROAD/PCC/WALLS/GATES'),
  (1, 20, 'BATHROOM AREA CONSTRUCTION'),
  (1, 21, 'PLUMBING'),
  (1, 22, 'CLEANING/BATHROOM CLEANING'),
  (1, 23, 'DRAINAGE'),
  (1, 24, 'HANDWASH'),
  (1, 25, 'BORING'),
  (1, 26, 'OTHER OFFICES'),
  (1, 27, 'MAWAID HANGER'),
  (1, 28, 'FMB INFRASTURCTURE'),
  (1, 29, 'TRANSPORTATION/LABOUR'),
  (1, 30, 'MEDICAL CAMPX1'),
  (1, 31, 'CONTINGENCY'),
  (1, 32, 'SOUND SYSTEM'),
  (1, 33, 'ZABIHAT'),
  (1, 34, 'COMPUTER + PRINTER {NEW PURCHASE}'),
  (1, 35, 'WATER + TEA + SNACKS'),
  (1, 36, 'HELPER + CLEANER'),
  (1, 37, '{HONORARIUM}'),
  (1, 38, 'CONSTRUCTION OF OFFICE'),
  (1, 39, 'FIRE EXTINGUISHERS'),
  (1, 40, 'FIRE TRUCK'),
  (1, 41, 'BASE PLATE'),
  (1, 42, 'BEAUTIFICATION');

insert into public.zone (department_id, zone_number, name) values
  (1, 1,  'VR MALL'),
  (1, 2,  'KHAIMAT BACKSIDE'),
  (1, 3,  'BEGAMWADI'),
  (1, 4,  'MOZZAM SEHEN'),
  (1, 5,  'ROZA SEHEN + DEVRI'),
  (1, 6,  'SEHEN POWER'),
  (1, 7,  'MASKAN PLOT'),
  (1, 8,  'MT SCHOOL'),
  (1, 9,  'DUMAS SCHOOL'),
  (1, 10, 'GOPIPURA'),
  (1, 11, 'NAJMI MASJID'),
  (1, 12, 'SHEHABI COLONY'),
  (1, 13, 'OFFICE EXPENSE');

insert into public.entry_status (code, label, source_system, sort_order, is_terminal) values
  ('pending',   'Pending',      'departmental', 1, false),
  ('sent_main', 'Sent to Main', 'departmental', 2, false),
  ('approved',  'Approved',     'main',         1, true);

insert into public.hub_status (code, label, sort_order, is_exportable, is_terminal) values
  ('not_set',               'Not set',               1, false, false),
  ('awaiting_verification', 'Awaiting Verification', 2, true,  false),
  ('awaiting_validation',   'Awaiting Validation',   3, true,  false);
