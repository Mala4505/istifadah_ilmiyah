-- Two budget heads in the Dept-module export had no matching sub-department
-- (found 2026-10-09 by scripts/import-bill-lines.mjs and a full bracket check):
--   'Matahir (Other Expenses)'                                   -> Matahir / Other Expenses
--   '649-01-04-Aljamea tus Saifiyah (TV/Video (setup) - Relay)'  -> Aljamea tus Saifiyah / TV/Video (setup) - Relay
-- 12 bill lines (Rs 4,80,570) could not be placed in a sub-department because of this.
--
-- Looked up by department NAME, not id, so the migration means the same thing in
-- every environment. Each new sub-department joins every event its department
-- already belongs to, same as one added from the Settings screen.
--
-- No budget is set here: sub_department_budget_allocation rows come from the
-- sub-department budget import (import_batch_id is required). The export's
-- Request amounts are Rs 2,14,053 (Matahir) and Rs 2,98,000 (Aljamea) -- load
-- them through that import.

insert into public.sub_department (department_id, name)
select d.id, v.name
  from (values
          ('Matahir', 'Other Expenses'),
          ('Aljamea tus Saifiyah', 'TV/Video (setup) - Relay')
       ) as v(department, name)
  join public.department d on d.name = v.department
on conflict (department_id, name) do nothing;

insert into public.event_sub_department (event_id, sub_department_id)
select ed.event_id, sd.id
  from public.sub_department sd
  join public.department d on d.id = sd.department_id
  join public.event_department ed on ed.department_id = d.id
 where (d.name, sd.name) in (('Matahir', 'Other Expenses'),
                             ('Aljamea tus Saifiyah', 'TV/Video (setup) - Relay'))
on conflict do nothing;
