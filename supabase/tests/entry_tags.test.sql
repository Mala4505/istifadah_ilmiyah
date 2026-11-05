-- SQL tests for supabase/migrations/20261105100000_entry_tags.sql (docs/entry-tags-plan.md, Phase 1)
-- and 20261105110000_entry_tags_department_change.sql (section 9: department change).
--
-- Non-destructive: everything runs inside ONE transaction that ends in ROLLBACK. Fixture
-- users, departments, events and entries are created inside it and never committed.
-- Run as the database owner (postgres), e.g. with the repo's DATABASE_URL or
--   npx supabase db query --linked -f supabase/tests/entry_tags.test.sql
-- Staging: replace `public.` -> `staging.` and `private.` -> `staging_private.` first
-- (docs/staging.md). Output: one row per check (test, pass, detail), then a summary row.
--
-- Roles: `superadmin` writes; `admin` sees every department (can_see_department
-- semantics) but cannot write; `dept` sees only its own departments. The plan's "an admin
-- cannot see tags outside their departments" is the `dept` role here -- an `admin` has
-- no department limit anywhere in this schema.

begin;

create temp table _fx (k text primary key, v text not null);
create temp table _results (n serial primary key, test text not null, pass boolean not null, detail text);
grant all on _fx, _results to authenticated;
grant usage on sequence _results_n_seq to authenticated;

create function pg_temp.fx(p text) returns text language sql stable as $$
  select v from pg_temp._fx where k = p
$$;
create function pg_temp.fxi(p text) returns bigint language sql stable as $$
  select v::bigint from pg_temp._fx where k = p
$$;
create function pg_temp.ok(p_test text, p_pass boolean, p_detail text default null) returns void
language sql as $$
  insert into pg_temp._results (test, pass, detail) values (p_test, coalesce(p_pass, false), p_detail)
$$;
-- Become an authenticated user (transaction-local, like a PostgREST request).
create function pg_temp.act_as(p_key text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', pg_temp.fx(p_key), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
-- Back to the session user (the owner).
create function pg_temp.as_owner() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures (as owner)
-- ---------------------------------------------------------------------------
do $$
declare
  v_run text := substr(md5(random()::text), 1, 8);
  v_uid uuid;
  v_role text;
  v_d1 bigint; v_d2 bigint; v_s1 bigint; v_s2 bigint;
  v_e1 bigint; v_e2 bigint; v_e3 bigint; v_e5 bigint; v_cur bigint;
  v_id bigint;
begin
  insert into pg_temp._fx values ('run', v_run);

  foreach v_role in array array['superadmin', 'admin', 'dept'] loop
    v_uid := gen_random_uuid();
    insert into auth.users (id, instance_id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values (v_uid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
            'tagtest-' || v_role || '-' || v_run || '@example.invalid',
            jsonb_build_object('role', v_role, 'is_active', true), '{}'::jsonb, now(), now());
    insert into public.staff_profile (id, display_name, role, is_active)
    values (v_uid, 'tagtest ' || v_role, v_role, true)
    on conflict (id) do update set role = excluded.role, is_active = true;
    insert into pg_temp._fx values (v_role, v_uid::text);
  end loop;

  insert into public.department (name) values ('zz tagtest D1 ' || v_run) returning id into v_d1;
  insert into public.department (name) values ('zz tagtest D2 ' || v_run) returning id into v_d2;
  insert into public.sub_department (department_id, name) values (v_d1, 'zz tagtest S1 ' || v_run) returning id into v_s1;
  insert into public.sub_department (department_id, name) values (v_d2, 'zz tagtest S2 ' || v_run) returning id into v_s2;
  insert into public.staff_department (staff_id, department_id) values (pg_temp.fx('dept')::uuid, v_d1);

  -- E1 < E2 < E3 by hijri_year (no starts_on). E5 has an EARLIER hijri_year than E1
  -- but a LATER starts_on; E1 also gets a starts_on, so E1 < E5 by date.
  insert into public.event (name, hijri_year, starts_on) values ('tagtest E1', '1301', '2030-01-01') returning id into v_e1;
  insert into public.event (name, hijri_year) values ('tagtest E2', '1302') returning id into v_e2;
  insert into public.event (name, hijri_year) values ('tagtest E3', '1303') returning id into v_e3;
  insert into public.event (name, hijri_year, starts_on) values ('tagtest E5', '1299', '2031-01-01') returning id into v_e5;
  select id into v_cur from public.event where is_current;

  insert into pg_temp._fx values ('d1', v_d1), ('d2', v_d2), ('s1', v_s1), ('s2', v_s2),
    ('e1', v_e1), ('e2', v_e2), ('e3', v_e3), ('e5', v_e5), ('cur', v_cur);

  -- entries
  insert into public.entries (ubbl_number, event_id, department_id, sub_department_id, amount)
  values ('TAGTEST-' || v_run || '-1', v_e2, v_d1, v_s1, 100) returning id into v_id;
  insert into pg_temp._fx values ('en1', v_id);                 -- D1/S1, E2, 100
  insert into public.entries (ubbl_number, event_id, department_id, amount)
  values ('TAGTEST-' || v_run || '-2', v_cur, v_d2, 50) returning id into v_id;
  insert into pg_temp._fx values ('en2', v_id);                 -- D2/no sub, current event, 50
  insert into public.entries (ubbl_number, event_id, department_id, amount)
  values ('TAGTEST-' || v_run || '-3', v_e1, v_d1, 30) returning id into v_id;
  insert into pg_temp._fx values ('en3', v_id);                 -- D1, E1 (older), 30
  insert into public.entries (ubbl_number, event_id, department_id, amount, is_void)
  values ('TAGTEST-' || v_run || '-4', v_e2, v_d1, 70, true) returning id into v_id;
  insert into pg_temp._fx values ('en4', v_id);                 -- D1, E2, 70, VOID
  insert into public.entries (ubbl_number, event_id, department_id, amount)
  values ('TAGTEST-' || v_run || '-5', v_e3, v_d2, 20) returning id into v_id;
  insert into pg_temp._fx values ('en5', v_id);                 -- D2, E3, 20
end $$;

-- Superadmin creates tag A (start E2, no scope yet) and tag B (start E2, manual scope D2).
do $$
declare v_a bigint; v_b bigint;
begin
  perform pg_temp.act_as('superadmin');
  insert into public.tag (name, start_event_id) values ('tagtest A', pg_temp.fxi('e2')) returning id into v_a;
  insert into public.tag (name, start_event_id) values ('tagtest B', pg_temp.fxi('e2')) returning id into v_b;
  insert into public.tag_scope (tag_id, department_id) values (v_b, pg_temp.fxi('d2'));
  insert into pg_temp._fx values ('a', v_a), ('b', v_b);
  perform pg_temp.ok('setup: superadmin can create tags and manual scope', true);
  perform pg_temp.as_owner();
exception when others then
  perform pg_temp.ok('setup: superadmin can create tags and manual scope', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 1. Linking an entry adds scope
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.act_as('superadmin');
  insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('a'), pg_temp.fxi('en1'));
  perform pg_temp.as_owner();
  perform pg_temp.ok('1. linking an entry adds its department + sub-department',
    exists (select 1 from public.tag_scope where tag_id = pg_temp.fxi('a')
            and department_id = pg_temp.fxi('d1') and sub_department_id = pg_temp.fxi('s1')
            and source = 'entry'));
  perform pg_temp.ok('1b. link is stamped with the linking user',
    (select linked_by::text from public.tag_entry where tag_id = pg_temp.fxi('a') and entry_id = pg_temp.fxi('en1'))
      = pg_temp.fx('superadmin'));
exception when others then
  perform pg_temp.ok('1. linking an entry adds its department + sub-department', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Entry with no sub-department -> department-only scope, no error
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.ok('2a. fixture entry 2 has no sub-department',
    (select sub_department_id from public.entries where id = pg_temp.fxi('en2')) is null);
  perform pg_temp.act_as('superadmin');
  insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('a'), pg_temp.fxi('en2'));
  perform pg_temp.as_owner();
  perform pg_temp.ok('2. entry without sub-department adds department-only scope without error',
    exists (select 1 from public.tag_scope where tag_id = pg_temp.fxi('a')
            and department_id = pg_temp.fxi('d2') and sub_department_id is null));
exception when others then
  perform pg_temp.ok('2. entry without sub-department adds department-only scope without error', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Sub-department set later is added to the tag (by an ADMIN, who cannot write
--    tag_scope directly -- the trigger must still add it)
-- ---------------------------------------------------------------------------
do $$
declare v_rows int;
begin
  perform pg_temp.act_as('admin');
  update public.entries set sub_department_id = pg_temp.fxi('s2') where id = pg_temp.fxi('en2');
  get diagnostics v_rows = row_count;
  perform pg_temp.as_owner();
  perform pg_temp.ok('3a. admin updated the entry''s sub-department', v_rows = 1, 'rows=' || v_rows);
  perform pg_temp.ok('3. sub-department set later is added to the tag',
    exists (select 1 from public.tag_scope where tag_id = pg_temp.fxi('a')
            and department_id = pg_temp.fxi('d2') and sub_department_id = pg_temp.fxi('s2')
            and source = 'entry'));
  perform pg_temp.ok('3b. the department-only row is kept',
    exists (select 1 from public.tag_scope where tag_id = pg_temp.fxi('a')
            and department_id = pg_temp.fxi('d2') and sub_department_id is null));
exception when others then
  perform pg_temp.ok('3. sub-department set later is added to the tag', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Unlinking keeps scope
-- ---------------------------------------------------------------------------
do $$
declare v_before int; v_after int;
begin
  select count(*) into v_before from public.tag_scope where tag_id = pg_temp.fxi('a');
  perform pg_temp.act_as('superadmin');
  delete from public.tag_entry where tag_id = pg_temp.fxi('a') and entry_id = pg_temp.fxi('en2');
  perform pg_temp.as_owner();
  select count(*) into v_after from public.tag_scope where tag_id = pg_temp.fxi('a');
  perform pg_temp.ok('4. unlinking an entry keeps the scope rows',
    v_before = v_after and v_after = 3
    and not exists (select 1 from public.tag_entry where tag_id = pg_temp.fxi('a') and entry_id = pg_temp.fxi('en2')),
    format('before=%s after=%s', v_before, v_after));
exception when others then
  perform pg_temp.ok('4. unlinking an entry keeps the scope rows', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 5. An older entry moves the start event back; a later one does not move it
-- ---------------------------------------------------------------------------
do $$
begin
  perform pg_temp.act_as('superadmin');
  insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('a'), pg_temp.fxi('en3'));
  insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('b'), pg_temp.fxi('en5'));
  perform pg_temp.as_owner();
  perform pg_temp.ok('5. older entry moves the start event back',
    (select start_event_id from public.tag where id = pg_temp.fxi('a')) = pg_temp.fxi('e1'));
  perform pg_temp.ok('5b. later entry does not move the start event',
    (select start_event_id from public.tag where id = pg_temp.fxi('b')) = pg_temp.fxi('e2'));
exception when others then
  perform pg_temp.ok('5. older entry moves the start event back', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Voided entries are excluded from cost (but counted)
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  perform pg_temp.act_as('superadmin');
  insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('a'), pg_temp.fxi('en4'));
  select * into r from public.tag_cost_by_event where tag_id = pg_temp.fxi('a') and event_id = pg_temp.fxi('e2');
  perform pg_temp.as_owner();
  perform pg_temp.ok('6. voided entries are excluded from cost',
    r.cost = 100 and r.entry_count = 1 and r.voided_count = 1,
    format('cost=%s entry_count=%s voided_count=%s', r.cost, r.entry_count, r.voided_count));
  perform pg_temp.ok('6b. voided entry stays linked',
    exists (select 1 from public.tag_entry where tag_id = pg_temp.fxi('a') and entry_id = pg_temp.fxi('en4')));
exception when others then
  perform pg_temp.ok('6. voided entries are excluded from cost', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 7. An admin cannot write (any of the four tables); neither can a dept user
-- ---------------------------------------------------------------------------
do $$
declare
  v_who text;
  v_rows int;
  v_sqlstate text;
begin
  foreach v_who in array array['admin', 'dept'] loop
    perform pg_temp.act_as(v_who);

    begin
      insert into public.tag (name, start_event_id) values ('tagtest forbidden', pg_temp.fxi('e2'));
      v_sqlstate := 'no error';
    exception when others then v_sqlstate := sqlstate;
    end;
    perform pg_temp.ok(format('7. %s cannot insert tag', v_who), v_sqlstate = '42501', v_sqlstate);

    update public.tag set name = 'tagtest hacked' where id = pg_temp.fxi('a');
    get diagnostics v_rows = row_count;
    perform pg_temp.ok(format('7. %s cannot update tag', v_who), v_rows = 0, 'rows=' || v_rows);

    delete from public.tag where id = pg_temp.fxi('a');
    get diagnostics v_rows = row_count;
    perform pg_temp.ok(format('7. %s cannot delete tag', v_who), v_rows = 0, 'rows=' || v_rows);

    begin
      insert into public.tag_entry (tag_id, entry_id) values (pg_temp.fxi('b'), pg_temp.fxi('en1'));
      v_sqlstate := 'no error';
    exception when others then v_sqlstate := sqlstate;
    end;
    perform pg_temp.ok(format('7. %s cannot link an entry', v_who), v_sqlstate = '42501', v_sqlstate);

    delete from public.tag_entry where tag_id = pg_temp.fxi('a');
    get diagnostics v_rows = row_count;
    perform pg_temp.ok(format('7. %s cannot unlink an entry', v_who), v_rows = 0, 'rows=' || v_rows);

    begin
      insert into public.tag_scope (tag_id, department_id) values (pg_temp.fxi('a'), pg_temp.fxi('d1'));
      v_sqlstate := 'no error';
    exception when others then v_sqlstate := sqlstate;
    end;
    perform pg_temp.ok(format('7. %s cannot add scope', v_who), v_sqlstate = '42501', v_sqlstate);

    delete from public.tag_scope where tag_id = pg_temp.fxi('a');
    get diagnostics v_rows = row_count;
    perform pg_temp.ok(format('7. %s cannot remove scope', v_who), v_rows = 0, 'rows=' || v_rows);

    begin
      insert into public.tag_event_note (tag_id, event_id, note) values (pg_temp.fxi('a'), pg_temp.fxi('e2'), 'x');
      v_sqlstate := 'no error';
    exception when others then v_sqlstate := sqlstate;
    end;
    perform pg_temp.ok(format('7. %s cannot write a note', v_who), v_sqlstate = '42501', v_sqlstate);

    perform pg_temp.as_owner();
  end loop;

  perform pg_temp.ok('7b. tag A unchanged after the attempts',
    (select name from public.tag where id = pg_temp.fxi('a')) = 'tagtest A'
    and (select count(*) from public.tag_entry where tag_id = pg_temp.fxi('a')) = 3
    and (select count(*) from public.tag_scope where tag_id = pg_temp.fxi('a')) = 4);  -- D1/S1, D2, D2/S2, D1 (from entry 3)
exception when others then
  perform pg_temp.ok('7. admin cannot write', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 8. A dept user cannot see tags outside their departments (admin sees all)
--    Tag A has scope D1 (dept user's department) + D2; tag B has scope D2 only.
-- ---------------------------------------------------------------------------
do $$
declare
  v_tags bigint[];
  v_scope_b int; v_scope_a int; v_notes_b int; v_links_b int; v_cost_b int; v_active bigint[];
begin
  -- superadmin writes a note on each tag in E2
  perform pg_temp.act_as('superadmin');
  insert into public.tag_event_note (tag_id, event_id, note) values
    (pg_temp.fxi('a'), pg_temp.fxi('e2'), '1302: note A'),
    (pg_temp.fxi('b'), pg_temp.fxi('e2'), '1302: note B');

  perform pg_temp.act_as('dept');
  select array_agg(id order by id) into v_tags from public.tag where id in (pg_temp.fxi('a'), pg_temp.fxi('b'));
  select count(*) into v_scope_a from public.tag_scope where tag_id = pg_temp.fxi('a');
  select count(*) into v_scope_b from public.tag_scope where tag_id = pg_temp.fxi('b');
  select count(*) into v_notes_b from public.tag_event_note where tag_id = pg_temp.fxi('b');
  select count(*) into v_links_b from public.tag_entry where tag_id = pg_temp.fxi('b');
  select count(*) into v_cost_b from public.tag_cost_by_event where tag_id = pg_temp.fxi('b');
  select array_agg(id order by id) into v_active from public.tags_active_in_event(pg_temp.fxi('e2'))
    where id in (pg_temp.fxi('a'), pg_temp.fxi('b'));
  perform pg_temp.as_owner();

  perform pg_temp.ok('8. dept user sees the tag in their department, not the other',
    v_tags = array[pg_temp.fxi('a')], coalesce(v_tags::text, 'none'));
  perform pg_temp.ok('8b. dept user sees all departments of a visible tag', v_scope_a = 4, 'scope rows=' || v_scope_a);
  perform pg_temp.ok('8c. dept user sees nothing of the hidden tag (scope, notes, links, cost)',
    v_scope_b = 0 and v_notes_b = 0 and v_links_b = 0 and v_cost_b = 0,
    format('scope=%s notes=%s links=%s cost=%s', v_scope_b, v_notes_b, v_links_b, v_cost_b));
  perform pg_temp.ok('8d. tags_active_in_event respects visibility for dept user',
    v_active = array[pg_temp.fxi('a')], coalesce(v_active::text, 'none'));

  perform pg_temp.act_as('admin');
  select array_agg(id order by id) into v_tags from public.tag where id in (pg_temp.fxi('a'), pg_temp.fxi('b'));
  perform pg_temp.as_owner();
  perform pg_temp.ok('8e. admin (all departments) sees both tags',
    v_tags = array[pg_temp.fxi('a'), pg_temp.fxi('b')], coalesce(v_tags::text, 'none'));
exception when others then
  perform pg_temp.ok('8. dept user cannot see tags outside their departments', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- Extra checks: period check, NULLS NOT DISTINCT, active-in-event, keep-one-department,
-- cascade delete
-- ---------------------------------------------------------------------------
do $$
declare v_sqlstate text; v_c bigint; v_d bigint;
begin
  perform pg_temp.act_as('superadmin');

  begin
    insert into public.tag (name, start_event_id, end_event_id) values ('tagtest bad', pg_temp.fxi('e2'), pg_temp.fxi('e1'));
    v_sqlstate := 'no error';
  exception when others then v_sqlstate := sqlstate;
  end;
  perform pg_temp.ok('x1. end event before start event is rejected', v_sqlstate = '23514', v_sqlstate);

  begin
    update public.tag set end_event_id = pg_temp.fxi('e1') where id = pg_temp.fxi('b');  -- B starts E2
    v_sqlstate := 'no error';
  exception when others then v_sqlstate := sqlstate;
  end;
  perform pg_temp.ok('x1b. updating end event to before start is rejected', v_sqlstate = '23514', v_sqlstate);

  -- tag C: E1 -> E2 (closed period). end = start is fine too.
  insert into public.tag (name, start_event_id, end_event_id) values ('tagtest C', pg_temp.fxi('e1'), pg_temp.fxi('e2')) returning id into v_c;
  insert into public.tag_scope (tag_id, department_id) values (v_c, pg_temp.fxi('d1'));
  insert into public.tag (name, start_event_id, end_event_id) values ('tagtest D', pg_temp.fxi('e2'), pg_temp.fxi('e2')) returning id into v_d;
  insert into public.tag_scope (tag_id, department_id) values (v_d, pg_temp.fxi('d1'));
  perform pg_temp.ok('x2. end event equal to start event is allowed', true);

  begin
    insert into public.tag_scope (tag_id, department_id, sub_department_id) values (pg_temp.fxi('a'), pg_temp.fxi('d2'), null);
    v_sqlstate := 'no error';
  exception when others then v_sqlstate := sqlstate;
  end;
  perform pg_temp.ok('x3. duplicate department-only scope rejected (NULLS NOT DISTINCT)', v_sqlstate = '23505', v_sqlstate);

  perform pg_temp.ok('x4. closed tag active in its start and end events',
    exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e1')) where id = v_c)
    and exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e2')) where id = v_c));
  perform pg_temp.ok('x4b. closed tag not active after its end event',
    not exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e3')) where id = v_c));
  perform pg_temp.ok('x4c. tag not active before its start event',
    not exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e1')) where id = v_d));
  perform pg_temp.ok('x4d. perpetual tag active in every later event',
    exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e3')) where id = pg_temp.fxi('a'))
    and exists (select 1 from public.tags_active_in_event(pg_temp.fxi('cur')) where id = pg_temp.fxi('a')));
  perform pg_temp.ok('x4e. starts_on wins over hijri_year when both events have it (E1 2030 < E5 2031, though 1301 > 1299)',
    exists (select 1 from public.tags_active_in_event(pg_temp.fxi('e5')) where id = pg_temp.fxi('a')));

  begin
    delete from public.tag_scope where tag_id = v_c;
    v_sqlstate := 'no error';
  exception when others then v_sqlstate := sqlstate;
  end;
  perform pg_temp.ok('x5. last department of a tag cannot be removed', v_sqlstate = '23514', v_sqlstate);

  delete from public.tag_scope where tag_id = pg_temp.fxi('a') and department_id = pg_temp.fxi('d2') and sub_department_id is null;
  perform pg_temp.ok('x5b. superadmin can remove a scope row by hand while others remain',
    (select count(*) from public.tag_scope where tag_id = pg_temp.fxi('a')) = 3);

  delete from public.tag where id = v_c;
  perform pg_temp.as_owner();
  perform pg_temp.ok('x6. deleting a tag cascades to its scope rows',
    not exists (select 1 from public.tag_scope where tag_id = v_c));
  perform pg_temp.ok('x7. tag stamped with creator',
    (select created_by::text from public.tag where id = pg_temp.fxi('a')) = pg_temp.fx('superadmin'));
exception when others then
  perform pg_temp.ok('x. extra checks', false, sqlerrm);
end $$;

-- ---------------------------------------------------------------------------
-- 9. (20261105110000_entry_tags_department_change.sql) A linked entry's DEPARTMENT
--    changing adds the new department to its tags and keeps the old one -- with no
--    sub-department change at all.
-- ---------------------------------------------------------------------------
do $$
declare
  v_f bigint; v_g bigint; v_en6 bigint; v_en7 bigint; v_en8 bigint; v_rows int;
  v_before int;
begin
  -- fixtures (owner, current event so an admin may edit them): en6 = D1 without sub-department, en7 = D1/S1, en8 = D1 and linked to nothing
  insert into public.entries (ubbl_number, event_id, department_id, amount)
  values ('TAGTEST-' || pg_temp.fx('run') || '-6', pg_temp.fxi('cur'), pg_temp.fxi('d1'), 10) returning id into v_en6;
  insert into public.entries (ubbl_number, event_id, department_id, sub_department_id, amount)
  values ('TAGTEST-' || pg_temp.fx('run') || '-7', pg_temp.fxi('cur'), pg_temp.fxi('d1'), pg_temp.fxi('s1'), 10) returning id into v_en7;
  insert into public.entries (ubbl_number, event_id, department_id, amount)
  values ('TAGTEST-' || pg_temp.fx('run') || '-8', pg_temp.fxi('cur'), pg_temp.fxi('d1'), 10) returning id into v_en8;

  perform pg_temp.act_as('superadmin');
  insert into public.tag (name, start_event_id) values ('tagtest F', pg_temp.fxi('e2')) returning id into v_f;
  insert into public.tag (name, start_event_id) values ('tagtest G', pg_temp.fxi('e2')) returning id into v_g;
  insert into public.tag_entry (tag_id, entry_id) values (v_f, v_en6), (v_g, v_en7);
  perform pg_temp.as_owner();

  -- 9. department-only change (an ADMIN edits the entry; they cannot write tag_scope directly)
  perform pg_temp.act_as('admin');
  update public.entries set department_id = pg_temp.fxi('d2') where id = v_en6;
  get diagnostics v_rows = row_count;
  perform pg_temp.as_owner();
  perform pg_temp.ok('9a. admin changed the entry''s department only', v_rows = 1, 'rows=' || v_rows);
  perform pg_temp.ok('9. department-only change adds the new department to the tag',
    exists (select 1 from public.tag_scope where tag_id = v_f
            and department_id = pg_temp.fxi('d2') and sub_department_id is null and source = 'entry'));
  perform pg_temp.ok('9b. the old department stays on the tag',
    exists (select 1 from public.tag_scope where tag_id = v_f
            and department_id = pg_temp.fxi('d1') and sub_department_id is null and source = 'entry'));

  -- 9c. department change that leaves a sub-department of the OLD department on the entry:
  --     only a department-only row for the new department (never a mismatched pair)
  perform pg_temp.act_as('admin');
  update public.entries set department_id = pg_temp.fxi('d2') where id = v_en7;
  perform pg_temp.as_owner();
  perform pg_temp.ok('9c. stale sub-department is not paired with the new department',
    exists (select 1 from public.tag_scope where tag_id = v_g
            and department_id = pg_temp.fxi('d2') and sub_department_id is null)
    and not exists (select 1 from public.tag_scope where tag_id = v_g
            and department_id = pg_temp.fxi('d2') and sub_department_id is not null));
  perform pg_temp.ok('9d. the old department / sub-department row is kept',
    exists (select 1 from public.tag_scope where tag_id = v_g
            and department_id = pg_temp.fxi('d1') and sub_department_id = pg_temp.fxi('s1')));

  -- 9e. an unrelated edit adds nothing
  select count(*) into v_before from public.tag_scope where tag_id in (v_f, v_g);
  perform pg_temp.act_as('admin');
  update public.entries set amount = 11 where id = v_en6;
  perform pg_temp.as_owner();
  perform pg_temp.ok('9e. editing another column adds no scope',
    (select count(*) from public.tag_scope where tag_id in (v_f, v_g)) = v_before,
    format('before=%s', v_before));

  -- 9f. an entry linked to no tag: department change is fine and creates nothing
  select count(*) into v_before from public.tag_scope;
  perform pg_temp.act_as('admin');
  update public.entries set department_id = pg_temp.fxi('d2') where id = v_en8;
  perform pg_temp.as_owner();
  perform pg_temp.ok('9f. department change on an unlinked entry adds no scope',
    (select count(*) from public.tag_scope) = v_before);

  -- 9g. moving the entry back re-uses existing rows: no duplicate, no error
  perform pg_temp.act_as('admin');
  update public.entries set department_id = pg_temp.fxi('d1') where id = v_en6;
  update public.entries set department_id = pg_temp.fxi('d2') where id = v_en6;
  perform pg_temp.as_owner();
  perform pg_temp.ok('9g. moving back and forth does not duplicate scope rows',
    (select count(*) from public.tag_scope where tag_id = v_f) = 2,
    'rows=' || (select count(*) from public.tag_scope where tag_id = v_f));
exception when others then
  perform pg_temp.ok('9. department change reaches the entry''s tags', false, sqlerrm);
end $$;

select n, test, pass, detail from pg_temp._results order by n;
select count(*) as checks, count(*) filter (where not pass) as failures from pg_temp._results;

rollback;
