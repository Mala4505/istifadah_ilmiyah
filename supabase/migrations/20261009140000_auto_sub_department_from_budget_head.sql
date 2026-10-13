-- Auto-fill entries.sub_department_id from the portal's budget head.
--
-- The portal's budget head reads "<department-ish> (<sub-department>)", e.g.
-- 'Venue setup (AVIT)'. The bracket text IS the sub-department name: the
-- sub-department budgets uploaded match the module's per-head Request amounts
-- for all 235 heads (checked 2026-10-09). Until now a sub-department only
-- appeared once a reviewer linked a bill, so sub-department reports waited on
-- review. Now:
--
--   RULE (user's check): take the bracket text of the entry's budget head; if
--   the ENTRY'S OWN DEPARTMENT has a sub-department with exactly that name
--   (case and spacing ignored), save it. Otherwise leave it empty.
--
--   * Only ever fills an EMPTY sub_department_id -- a reviewer's choice is never
--     overwritten, and a reviewer deliberately clearing it is not undone.
--   * Runs as a trigger, so every scrape (and any other write) gets it with no
--     change to the import code.
--   * budget_head.sub_department_id is an optional MANUAL link for a label whose
--     bracket matches nothing (e.g. legacy 'Venue Setup (Accommodation)'); when
--     set, it wins over the bracket rule. Null = use the bracket rule.
--   * entries.sub_department_source records who set it: 'portal' (this rule),
--     'export' (scripts/import-bill-lines.mjs), 'reviewer' (a signed-in person).
--
-- Undo the one-time fill below:
--   update public.entries set sub_department_id = null, sub_department_source = null
--    where sub_department_source = 'portal';

alter table public.budget_head
  add column sub_department_id bigint references public.sub_department(id);

alter table public.entries
  add column sub_department_source text
    check (sub_department_source in ('portal', 'export', 'reviewer'));

-- Text inside the bracket group that closes at the very end of the label,
-- nesting-aware: 'Aljamea (TV/Video (setup) - Relay)' -> 'TV/Video (setup) - Relay',
-- 'HR (B) / KG Khidmat Takhmeen (Accommodation)' -> 'Accommodation'. Also returns
-- the first-'('-to-last-')' text as a second candidate, for a label whose closing
-- bracket is missing ('649-10-Aljamea tus Saifiyah (Mawarid Bashariyah (HR)').
create or replace function private.budget_head_bracket_candidates(label text)
returns text[]
language plpgsql
immutable
set search_path to ''
as $$
declare
  s text := btrim(coalesce(label, ''));
  depth int := 0;
  i int;
  ch text;
  outer_text text;
  first_open int;
begin
  if right(s, 1) <> ')' then
    return array[]::text[];
  end if;
  for i in reverse length(s)..1 loop
    ch := substr(s, i, 1);
    if ch = ')' then
      depth := depth + 1;
    elsif ch = '(' then
      depth := depth - 1;
      if depth = 0 then
        outer_text := substr(s, i + 1, length(s) - i - 1);
        exit;
      end if;
    end if;
  end loop;
  first_open := strpos(s, '(');
  return array_remove(array[
    outer_text,
    case when first_open > 0 then substr(s, first_open + 1, length(s) - first_open - 1) end
  ], null);
end;
$$;

create or replace function private.normalize_sub_department_name(name text)
returns text
language sql
immutable
set search_path to ''
as $$ select lower(regexp_replace(btrim(coalesce(name, '')), '\s+', ' ', 'g')) $$;

-- The sub-department for a budget head inside a given department, or null.
create or replace function private.sub_department_for_budget_head(p_budget_head_id bigint, p_department_id bigint)
returns bigint
language plpgsql
stable
set search_path to ''
as $$
declare
  v_label text;
  v_link bigint;
  v_candidate text;
  v_id bigint;
begin
  if p_budget_head_id is null or p_department_id is null then
    return null;
  end if;
  select bh.raw_label, bh.sub_department_id into v_label, v_link
    from public.budget_head bh where bh.id = p_budget_head_id;

  -- A manual link wins, but only inside the entry's own department.
  if v_link is not null then
    select sd.id into v_id from public.sub_department sd
     where sd.id = v_link and sd.department_id = p_department_id;
    if v_id is not null then
      return v_id;
    end if;
  end if;

  foreach v_candidate in array private.budget_head_bracket_candidates(v_label) loop
    select sd.id into v_id from public.sub_department sd
     where sd.department_id = p_department_id
       and private.normalize_sub_department_name(sd.name) = private.normalize_sub_department_name(v_candidate);
    if v_id is not null then
      return v_id;
    end if;
  end loop;
  return null;
end;
$$;

-- Named to sort before entries_before_update, so private.log_entry_change sees
-- (and logs) the filled value. Postgres fires same-event triggers alphabetically.
create or replace function private.fill_entry_sub_department()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  -- 1. Tag who set it, when the writer didn't say.
  if new.sub_department_id is null then
    new.sub_department_source := null;
  elsif tg_op = 'INSERT' or new.sub_department_id is distinct from old.sub_department_id then
    if tg_op = 'INSERT' and new.sub_department_source is null
       or tg_op = 'UPDATE' and new.sub_department_source is not distinct from old.sub_department_source then
      new.sub_department_source := case when auth.uid() is not null then 'reviewer' else 'export' end;
    end if;
  end if;

  -- 2. Fill an empty one from the budget head -- unless someone just cleared it.
  if new.sub_department_id is null
     and not (tg_op = 'UPDATE' and old.sub_department_id is not null) then
    new.sub_department_id := private.sub_department_for_budget_head(new.budget_head_id, new.department_id);
    if new.sub_department_id is not null then
      new.sub_department_source := 'portal';
    end if;
  end if;

  return new;
end;
$$;

create trigger entries_a_fill_sub_department
  before insert or update on public.entries
  for each row execute function private.fill_entry_sub_department();

-- ---- one-time backfill ------------------------------------------------------

-- Manual link: 'Daeratul Aqeeq - Happy Care (Accommodation)' brackets to plain
-- 'Accommodation', but Daeratul Aqeeq has its own 'Happy Care - Accommodation'
-- sub-department (with its own budget) that no label would otherwise reach.
update public.budget_head bh
   set sub_department_id = sd.id
  from public.sub_department sd
  join public.department d on d.id = sd.department_id
 where bh.raw_label = 'Daeratul Aqeeq - Happy Care (Accommodation)'
   and d.name = 'Daeratul Aqeeq'
   and sd.name = 'Happy Care - Accommodation';

-- Who set the sub-departments that already exist: a signed-in person per the
-- change log -> 'reviewer'; otherwise (the 2026-10-09 export import) -> 'export'.
-- Labelling only, not a real change, so it is kept out of the change history.
alter table public.entries disable trigger entries_before_update;
update public.entries e
   set sub_department_source = case
         when exists (
           select 1 from public.entry_change_log c
            where c.entry_id = e.id and c.changes ? 'sub_department_id' and c.changed_by is not null
         ) then 'reviewer'
         when exists (
           select 1 from public.entry_change_log c
            where c.entry_id = e.id and c.changes ? 'sub_department_id'
         ) then 'export'
         else 'reviewer'
       end
 where e.sub_department_id is not null;
alter table public.entries enable trigger entries_before_update;

-- Fill every empty one the rule can answer.
update public.entries e
   set sub_department_id     = private.sub_department_for_budget_head(e.budget_head_id, e.department_id),
       sub_department_source = 'portal'
 where e.sub_department_id is null
   and e.budget_head_id is not null
   and private.sub_department_for_budget_head(e.budget_head_id, e.department_id) is not null;
