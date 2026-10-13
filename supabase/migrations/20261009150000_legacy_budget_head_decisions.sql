-- Follow-up to 20261009140000 (already applied), user decisions 2026-10-09 on
-- the 75 entries that rule could not fill.
--
-- Unassigned spend is NOT lost: v_department_budget_vs_actual counts every
-- non-void entry of a department against the department budget, with or without
-- a sub-department. Only the sub-department breakdown leaves it out.

-- Manual link (user, 2026-10-09): the typo label 'Daeratul Aqeeq (Printing &
-- Staionery)' -> 'Printing & Stationery'. The other legacy labels with no
-- matching sub-department (Flow Management / Transport (Signages), Madaris
-- Imaniyah (AVIT) / (Venue Setup), Venue Setup (Civil Works) / (Accommodation),
-- Venue setup (Tazyeen), Nazafat (Consumables)) are deliberately left UNLINKED:
-- new entries on them stay without a sub-department. Their spend still counts
-- against the department's budget (v_department_budget_vs_actual sums every
-- non-void entry of the department, with or without a sub-department).
update public.budget_head bh
   set sub_department_id = sd.id
  from public.sub_department sd
  join public.department d on d.id = sd.department_id
 where bh.raw_label = 'Daeratul Aqeeq (Printing & Staionery)'
   and d.name = 'Daeratul Aqeeq'
   and sd.name = 'Printing & Stationery';

-- The typo label's 2 entries pick the link up now.
update public.entries e
   set sub_department_id     = private.sub_department_for_budget_head(e.budget_head_id, e.department_id),
       sub_department_source = 'portal'
  from public.budget_head bh
 where bh.id = e.budget_head_id
   and bh.raw_label = 'Daeratul Aqeeq (Printing & Staionery)'
   and e.sub_department_id is null;

-- One-off (user, 2026-10-09): entries on the unlinked legacy labels whose
-- sub-department is settled by what reviewers already chose -- for the same
-- vendor under the same label first, otherwise the label's reviewer choice.
-- Marked 'portal' (a suggestion); a reviewer can still change any of them.
update public.entries e
   set sub_department_id     = sd.id,
       sub_department_source = 'portal'
  from (values
          -- Nazafat (Consumables): reviewers chose Other Expenses 9/9, incl. Nakoda Trading
          ('2026092476',   'Nazafat',     'Other Expenses'),
          ('2026092472-1', 'Nazafat',     'Other Expenses'),
          ('2026092477',   'Nazafat',     'Other Expenses'),
          ('2026092474',   'Nazafat',     'Other Expenses'),
          ('2026092473',   'Nazafat',     'Other Expenses'),
          ('2026092475',   'Nazafat',     'Other Expenses'),
          -- Venue setup (Tazyeen): reviewers chose Other setup expenses 8/9
          ('2026100510',   'Venue Setup', 'Other setup expenses'),
          ('2026092794',   'Venue Setup', 'Other setup expenses'),
          ('20260930109',  'Venue Setup', 'Other setup expenses'),
          ('202609297',    'Venue Setup', 'Other setup expenses'),
          ('202609296',    'Venue Setup', 'Other setup expenses'),
          -- Venue Setup (Accommodation): reviewer chose Other setup expenses (Miqaat)
          ('ADP_202608203','Venue Setup', 'Other setup expenses'),
          ('IAU_202609161','Venue Setup', 'Other setup expenses'),
          ('ADP_202608191','Venue Setup', 'Other setup expenses'),
          -- Venue Setup (Civil Works): same vendor reviewed as Labour
          ('2026091210',   'Venue Setup', 'Labour'),
          ('2026092125',   'Venue Setup', 'Labour'),
          ('2026091219',   'Venue Setup', 'Labour'),
          -- Venue Setup (Civil Works): no vendor history; label's larger reviewer choice
          ('202608197',    'Venue Setup', 'Other setup expenses'),
          ('202609146',    'Venue Setup', 'Other setup expenses'),
          ('202609147',    'Venue Setup', 'Other setup expenses'),
          ('202609126',    'Venue Setup', 'Other setup expenses')
       ) as v(ubbl_number, department, sub_department)
  join public.department d on d.name = v.department
  join public.sub_department sd on sd.department_id = d.id and sd.name = v.sub_department
 where e.ubbl_number = v.ubbl_number
   and e.department_id = d.id
   and e.sub_department_id is null;
