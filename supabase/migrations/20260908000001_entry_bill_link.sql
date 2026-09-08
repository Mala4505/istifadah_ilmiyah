-- Entries <-> Bills many-to-many, Phase 1 (plan: entry-bill links with
-- automatic variance).
--
-- Today a bill points at exactly one entry: document_extraction.entry_id and
-- source_document.entry_id are scalar FKs (20260817000002), and every view
-- reconciles the two with coalesce(de.entry_id, sd.entry_id). "One entry, many
-- bills" works; "one bill, many entries" does not. Reality is many-to-many.
--
-- This migration adds the junction table, its RLS, the RPC write surface, a
-- one-time backfill from the two scalar columns, and a TEMPORARY one-way
-- junction -> scalar mirror trigger so every existing reader keeps working
-- untouched until Phase 4 migrates them. Nothing reads the junction yet.
--
-- Decisions (from the plan, taken with the user):
--   * Genuinely many-to-many via a junction table.
--   * NO allocated-amount column, no manual splitting -- a link is created or
--     deleted, never edited. Totals are computed from entries.amount /
--     document_extraction.total_amount_* at read time (Phase 2 views).
--   * NO event_id column -- derivable from both sides; the write RPCs reject a
--     cross-event link instead of storing a third copy.
--   * Junction is at BILL grain (document_extraction) with
--     document_extraction_id NULLABLE as a PDF-grain escape hatch: a document
--     can be attached before extraction has produced any bills
--     (app/api/documents/ingest/route.ts, attachDocumentToEntry). NULL = the
--     bills are not known yet; the extract handler promotes the placeholder to
--     per-bill rows.
--
-- NOT in this migration (deliberately, so "all existing views keep working"):
--   * source_document.match_status stays exactly as it is (still set by the
--     application). It becomes trigger-derived in Phase 4.
--   * No consumer rewrites. coalesce(de.entry_id, sd.entry_id) is still the
--     truth for every view; the mirror trigger keeps those columns coherent.

-- ===========================================================================
-- 0. FK target for the bill-grain "MATCH SIMPLE" pin.
-- ===========================================================================
-- entry_bill_link_extraction_fk (below) pins document_extraction_id to the
-- bill's own parent source_document, declaratively (no trigger). That needs a
-- unique key on the referenced (id, source_document_id) pair. id is already the
-- PK so this is redundant as a data constraint but required as an FK target.
alter table public.document_extraction
  add constraint document_extraction_id_source_document_id_key
    unique (id, source_document_id);

-- ===========================================================================
-- 1. entry_bill_link -- the junction
-- ===========================================================================
create table public.entry_bill_link (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.entries(id) on delete cascade,
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  document_extraction_id bigint,                 -- NULL = pre-extraction placeholder
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),

  -- MATCH SIMPLE: auto-satisfied while document_extraction_id is null,
  -- otherwise pins source_document_id to the bill's own parent. Declarative,
  -- no trigger.
  constraint entry_bill_link_extraction_fk
    foreign key (document_extraction_id, source_document_id)
    references public.document_extraction (id, source_document_id) on delete cascade
);

comment on table public.entry_bill_link is
  'Many-to-many between entries and bills (document_extraction). One row = "this entry falls under this bill". No rupee figure is stored -- totals are computed from entries.amount / document_extraction.total_amount_* at read time (v_entry_bill_variance / v_bill_entry_variance). document_extraction_id NULL = document attached before extraction; the extract handler promotes it. Writes are RPC-only. Feature: entry-bill links, 2026-09-08.';

-- One link per (bill, entry); and, for placeholders, one per (document, entry).
create unique index entry_bill_link_bill_entry_key
  on public.entry_bill_link (document_extraction_id, entry_id)
  where document_extraction_id is not null;
create unique index entry_bill_link_doc_entry_key
  on public.entry_bill_link (source_document_id, entry_id)
  where document_extraction_id is null;

-- Every FK indexed (repo convention).
create index entry_bill_link_entry_idx           on public.entry_bill_link (entry_id);
create index entry_bill_link_source_document_idx on public.entry_bill_link (source_document_id);
create index entry_bill_link_extraction_idx      on public.entry_bill_link (document_extraction_id)
  where document_extraction_id is not null;

-- ===========================================================================
-- 2. RLS
-- ===========================================================================
alter table public.entry_bill_link enable row level security;
alter table public.entry_bill_link force row level security;

-- can_see_entry -- SECURITY DEFINER because a bare subquery on entries inside a
-- policy would re-enter entries_select. Mirrors private.can_see_source_document.
create or replace function private.can_see_entry(p_entry_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (
    select 1 from public.entries e
    where e.id = p_entry_id
      and (select private.can_see_department(e.department_id))
  );
$$;

comment on function private.can_see_entry(bigint) is
  'Entry visibility gate -- SECURITY DEFINER twin of the entries_select policy (can_see_department on the entry''s department). Used by entry_bill_link RLS and the link RPCs. Feature: entry-bill links, 2026-09-08.';

-- Select scopes PER ROW: a dept-A reviewer sees the dept-A link and not the
-- dept-B link on a document both can see.
create policy entry_bill_link_select on public.entry_bill_link
  for select to authenticated
  using (
    (select private.can_see_source_document(source_document_id))
    and (select private.can_see_entry(entry_id))
  );

-- No insert/update/delete policy for authenticated: every write goes through
-- the RPCs below (same posture as source_document_assignee, 20260829000002).
grant select on public.entry_bill_link to authenticated;
revoke insert, update, delete on public.entry_bill_link from authenticated;

-- ===========================================================================
-- 3. Write RPCs
-- ===========================================================================
-- Shared guard. Raises on the first violation:
--   * caller is not a reviewer-or-admin;
--   * the document is not visible to the caller;
--   * an affected entry (added OR removed) is not visible to the caller;
--   * an affected entry is in a different event than the document;
--   * the document's event is not the current (mutable) event.
-- p_entry_ids is the FULL affected set -- callers pass (existing linked entries
-- for this bill/document) UNION (the requested new set) so a link the caller
-- cannot see can never be silently dropped.
create or replace function private.assert_entry_bill_link_allowed(
  p_source_document_id bigint,
  p_entry_ids bigint[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_event_id bigint;
  v_is_current boolean;
  v_bad bigint;
begin
  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Linking bills to entries requires the reviewer or admin role.';
  end if;

  select sd.event_id, e.is_current
    into v_event_id, v_is_current
  from public.source_document sd
  join public.event e on e.id = sd.event_id
  where sd.id = p_source_document_id;

  if v_event_id is null then
    raise exception 'Document % not found.', p_source_document_id;
  end if;

  if not (select private.can_see_source_document(p_source_document_id)) then
    raise exception 'You do not have access to document %.', p_source_document_id;
  end if;

  if not coalesce(v_is_current, false) then
    raise exception 'Document % belongs to a closed event -- links cannot be changed.', p_source_document_id;
  end if;

  -- Every affected entry: visible, and in the same event as the document.
  select x into v_bad
  from unnest(coalesce(p_entry_ids, '{}'::bigint[])) as x
  where not (select private.can_see_entry(x))
  limit 1;
  if v_bad is not null then
    raise exception 'You do not have access to entry %.', v_bad;
  end if;

  select e.id into v_bad
  from public.entries e
  where e.id = any (coalesce(p_entry_ids, '{}'::bigint[]))
    and e.event_id <> v_event_id
  limit 1;
  if v_bad is not null then
    raise exception 'Entry % is in a different event than document %.', v_bad, p_source_document_id;
  end if;
end;
$$;

-- --- bill grain -----------------------------------------------------------
create or replace function public.set_bill_entry_links(
  p_document_extraction_id bigint,
  p_entry_ids bigint[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint;
  v_new bigint[] := (
    select coalesce(array_agg(distinct x), '{}'::bigint[])
    from unnest(coalesce(p_entry_ids, '{}'::bigint[])) as x
  );
  v_affected bigint[];
begin
  select de.source_document_id into v_sd
  from public.document_extraction de
  where de.id = p_document_extraction_id;
  if v_sd is null then
    raise exception 'Bill % not found.', p_document_extraction_id;
  end if;

  select coalesce(array_agg(distinct l.entry_id), '{}'::bigint[]) into v_affected
  from public.entry_bill_link l
  where l.document_extraction_id = p_document_extraction_id;
  v_affected := (
    select coalesce(array_agg(distinct x), '{}'::bigint[])
    from unnest(v_affected || v_new) as x
  );

  perform private.assert_entry_bill_link_allowed(v_sd, v_affected);

  delete from public.entry_bill_link
  where document_extraction_id = p_document_extraction_id;

  insert into public.entry_bill_link
    (entry_id, source_document_id, document_extraction_id, created_by)
  select x, v_sd, p_document_extraction_id, (select auth.uid())
  from unnest(v_new) as x;
end;
$$;

create or replace function public.add_bill_entry_link(
  p_document_extraction_id bigint,
  p_entry_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint;
begin
  select de.source_document_id into v_sd
  from public.document_extraction de
  where de.id = p_document_extraction_id;
  if v_sd is null then
    raise exception 'Bill % not found.', p_document_extraction_id;
  end if;

  perform private.assert_entry_bill_link_allowed(v_sd, array[p_entry_id]);

  insert into public.entry_bill_link
    (entry_id, source_document_id, document_extraction_id, created_by)
  values (p_entry_id, v_sd, p_document_extraction_id, (select auth.uid()))
  on conflict (document_extraction_id, entry_id) where document_extraction_id is not null
  do nothing;
end;
$$;

create or replace function public.remove_bill_entry_link(
  p_document_extraction_id bigint,
  p_entry_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint;
begin
  select de.source_document_id into v_sd
  from public.document_extraction de
  where de.id = p_document_extraction_id;
  if v_sd is null then
    raise exception 'Bill % not found.', p_document_extraction_id;
  end if;

  perform private.assert_entry_bill_link_allowed(v_sd, array[p_entry_id]);

  delete from public.entry_bill_link
  where document_extraction_id = p_document_extraction_id
    and entry_id = p_entry_id;
end;
$$;

-- --- PDF grain -----------------------------------------------------------
-- A true document-grain replace: drops EVERY link for this source_document
-- (across all its bills and any placeholder rows) and re-links p_entry_ids to
-- every bill the document has -- or, if the document has no bills yet, writes
-- placeholder rows (document_extraction_id null) that the extract handler
-- promotes. This is what attachDocumentToEntry / bulkAttachDocuments call, so it
-- has to behave for 0, 1 and N bills uniformly (a multi-bill PDF attached from
-- the inbox links the entry to all of its bills, matching the pre-junction
-- coalesce(de.entry_id, sd.entry_id) fan-out).
create or replace function public.set_document_entry_links(
  p_source_document_id bigint,
  p_entry_ids bigint[]
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_new bigint[] := (
    select coalesce(array_agg(distinct x), '{}'::bigint[])
    from unnest(coalesce(p_entry_ids, '{}'::bigint[])) as x
  );
  v_bill_count int;
  v_affected bigint[];
begin
  select count(*) into v_bill_count
  from public.document_extraction de
  where de.source_document_id = p_source_document_id;

  select coalesce(array_agg(distinct l.entry_id), '{}'::bigint[]) into v_affected
  from public.entry_bill_link l
  where l.source_document_id = p_source_document_id;
  v_affected := (
    select coalesce(array_agg(distinct x), '{}'::bigint[])
    from unnest(v_affected || v_new) as x
  );

  perform private.assert_entry_bill_link_allowed(p_source_document_id, v_affected);

  delete from public.entry_bill_link
  where source_document_id = p_source_document_id;

  if v_bill_count = 0 then
    insert into public.entry_bill_link
      (entry_id, source_document_id, document_extraction_id, created_by)
    select x, p_source_document_id, null, (select auth.uid())
    from unnest(v_new) as x;
  else
    insert into public.entry_bill_link
      (entry_id, source_document_id, document_extraction_id, created_by)
    select x, p_source_document_id, de.id, (select auth.uid())
    from unnest(v_new) as x
    cross join public.document_extraction de
    where de.source_document_id = p_source_document_id;
  end if;
end;
$$;

create or replace function public.remove_entry_bill_links(
  p_source_document_id bigint,
  p_entry_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_entry_bill_link_allowed(p_source_document_id, array[p_entry_id]);

  delete from public.entry_bill_link
  where source_document_id = p_source_document_id
    and entry_id = p_entry_id;
end;
$$;

-- Belt and braces (same block as 20260905000001): revoke the default PUBLIC
-- grant Supabase attaches to new functions, then grant only authenticated.
revoke all on function public.set_bill_entry_links(bigint, bigint[])       from public, anon, authenticated;
revoke all on function public.add_bill_entry_link(bigint, bigint)          from public, anon, authenticated;
revoke all on function public.remove_bill_entry_link(bigint, bigint)       from public, anon, authenticated;
revoke all on function public.set_document_entry_links(bigint, bigint[])   from public, anon, authenticated;
revoke all on function public.remove_entry_bill_links(bigint, bigint)      from public, anon, authenticated;

grant execute on function public.set_bill_entry_links(bigint, bigint[])       to authenticated;
grant execute on function public.add_bill_entry_link(bigint, bigint)          to authenticated;
grant execute on function public.remove_bill_entry_link(bigint, bigint)       to authenticated;
grant execute on function public.set_document_entry_links(bigint, bigint[])   to authenticated;
grant execute on function public.remove_entry_bill_links(bigint, bigint)      to authenticated;

-- ===========================================================================
-- 4. Backfill from the two scalar columns
-- ===========================================================================
-- Step 1: per-bill matches (document_extraction.entry_id).
insert into public.entry_bill_link (entry_id, source_document_id, document_extraction_id, created_at)
select de.entry_id, de.source_document_id, de.id, now()
from public.document_extraction de
where de.entry_id is not null
on conflict do nothing;

-- Step 2: doc-level matches (source_document.entry_id) fanned out to every bill
-- of that document that has no per-bill match of its own.
--
-- >>> FAN-OUT NOTE: for a multi-bill PDF this attributes the one doc-level
-- entry to EVERY bill, so that entry's "billed total" would multiply. Run this
-- BEFORE applying the migration:
--
--   select count(*) from public.source_document sd
--   where sd.entry_id is not null
--     and (select count(*) from public.document_extraction de
--          where de.source_document_id = sd.id) > 1;
--
-- If that count is non-trivial, change `true` to `de.bill_index = 0` on the
-- marked line below (backfill only bill 0, reviewers link the rest by hand) --
-- but then the coalesce-vs-junction reconciliation check will legitimately
-- report those un-backfilled bills. On a single-event dataset this count is
-- expected to be 0.
insert into public.entry_bill_link (entry_id, source_document_id, document_extraction_id, created_at)
select sd.entry_id, sd.id, de.id, now()
from public.source_document sd
join public.document_extraction de on de.source_document_id = sd.id
where sd.entry_id is not null
  and de.entry_id is null
  and true   -- <<< change to `de.bill_index = 0` if the fan-out count is non-trivial
on conflict do nothing;

-- Step 3: PDF-grain placeholders -- documents attached but never extracted.
insert into public.entry_bill_link (entry_id, source_document_id, document_extraction_id, created_at)
select sd.entry_id, sd.id, null, now()
from public.source_document sd
where sd.entry_id is not null
  and not exists (
    select 1 from public.document_extraction de where de.source_document_id = sd.id
  )
on conflict do nothing;

-- Reconciliation assertion: coalesce(de.entry_id, sd.entry_id) must now be
-- represented in the junction for every bill. Zero rows expected.
do $$
declare
  v_missing int;
begin
  select count(*) into v_missing
  from public.document_extraction de
  join public.source_document sd on sd.id = de.source_document_id
  where coalesce(de.entry_id, sd.entry_id) is not null
    and not exists (
      select 1 from public.entry_bill_link l
      where l.document_extraction_id = de.id
        and l.entry_id = coalesce(de.entry_id, sd.entry_id)
    );
  if v_missing > 0 then
    raise exception 'entry_bill_link backfill incomplete: % bill(s) still not represented in the junction (fan-out note above).', v_missing;
  end if;
end;
$$;

-- ===========================================================================
-- 5. TEMPORARY one-way junction -> scalar mirror trigger
-- ===========================================================================
-- Created AFTER the backfill (the backfill already left the scalar columns and
-- the junction in agreement, and firing per-row across the whole table would be
-- pointless work). From here until Phase 4 migrates the readers, this keeps
-- document_extraction.entry_id / source_document.entry_id coherent as the RPCs
-- (wired up in Phase 3) mutate the junction.
--
-- Rule: a scalar mirror is only meaningful while a bill has <= 1 entry. When a
-- bill (or document) has 2+ distinct linked entries the mirror is set to NULL,
-- so old views render it as "unmatched" (visibly, not silently wrong) until the
-- reader rewrite lands. Multi-select is not exposed in the UI until Phase 5, so
-- no such row exists in practice during the mirror window.
--
-- Phase 6 (20260908000004) drops this trigger and both scalar columns.
create or replace function private.sync_entry_bill_link_mirror()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint := coalesce(new.source_document_id, old.source_document_id);
  v_de bigint := coalesce(new.document_extraction_id, old.document_extraction_id);
begin
  if v_de is not null then
    update public.document_extraction de
      set entry_id = (
        select min(l.entry_id)
        from public.entry_bill_link l
        where l.document_extraction_id = v_de
        having count(distinct l.entry_id) = 1
      )
      where de.id = v_de;
  end if;

  update public.source_document sd
    set entry_id = (
      select min(l.entry_id)
      from public.entry_bill_link l
      where l.source_document_id = v_sd
      having count(distinct l.entry_id) = 1
    )
    where sd.id = v_sd;

  return null;
end;
$$;

create trigger entry_bill_link_scalar_mirror
  after insert or delete on public.entry_bill_link
  for each row execute function private.sync_entry_bill_link_mirror();

comment on function private.sync_entry_bill_link_mirror() is
  'TEMPORARY (Phase 1 -> Phase 6). One-way junction -> scalar mirror: keeps document_extraction.entry_id / source_document.entry_id coherent with entry_bill_link while the ~20 legacy readers still use the scalar columns. 2+ distinct entries => NULL mirror (renders as unmatched, never silently wrong). Dropped with the scalar columns in 20260908000004.';
