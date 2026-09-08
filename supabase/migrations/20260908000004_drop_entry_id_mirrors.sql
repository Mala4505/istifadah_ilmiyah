-- Entries <-> Bills many-to-many, Phase 6 (plan: entry-bill links with
-- automatic variance).
--
-- ###########################################################################
-- ##  PARKED in docs/pending-migrations/ so `supabase db push` cannot pick  ##
-- ##  it up early. Move it back into supabase/migrations/ only when Phase 4 ##
-- ##  (20260908000003_entry_bill_link_readers.sql) is merged and verified.  ##
-- ##                                                                       ##
-- ##  DO NOT APPLY THIS MIGRATION UNTIL PHASE 4 IS MERGED AND VERIFIED.     ##
-- ##                                                                       ##
-- ##  Phase 4 (20260908000003_entry_bill_link_readers.sql) rewrites every  ##
-- ##  reader off document_extraction.entry_id / source_document.entry_id   ##
-- ##  and onto entry_bill_link / v_bill_primary_entry / the variance       ##
-- ##  views. This migration removes the scalar columns and the temporary   ##
-- ##  junction->scalar mirror trigger. Applied before Phase 4, it breaks   ##
-- ##  ~20 reporting views and several SECURITY DEFINER functions           ##
-- ##  (verify_document_extraction, match_candidate_entries,                ##
-- ##  can_see_source_document, ...).                                       ##
-- ##                                                                       ##
-- ##  Preconditions before applying:                                       ##
-- ##   1. Phase 4 merged; `npx supabase db reset` replays cleanly.         ##
-- ##   2. `npx tsc --noEmit` and `npx next lint` clean.                    ##
-- ##   3. Repo-wide grep for `source_document.*entry_id` and               ##
-- ##      `document_extraction.*entry_id` returns only this file and the   ##
-- ##      historical migrations that created/backfilled the columns.       ##
-- ##   4. Full `npx vitest run` + the integration RLS suite pass.          ##
-- ###########################################################################
--
-- The DROP COLUMN statements below are RESTRICT (the default) on purpose: if
-- any view still depends on a scalar column, Postgres aborts here and names
-- the object, rather than CASCADE silently dropping a live reporting view.
-- plpgsql function bodies are NOT tracked as dependencies, so the guard block
-- first checks the known SECURITY DEFINER functions for a lingering reference.

-- ---------------------------------------------------------------------------
-- Guard: fail loudly if a tracked function body still names the scalar columns.
-- ---------------------------------------------------------------------------
do $$
declare
  v_hits text;
begin
  select string_agg(p.proname, ', ')
    into v_hits
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'private')
    and p.proname in (
      'verify_document_extraction',
      'match_candidate_entries',
      'can_see_source_document',
      'sync_source_document_match_status'
    )
    and (
      p.prosrc ~ 'de\.entry_id'
      or p.prosrc ~ 'sd\.entry_id'
      or p.prosrc ~ 'document_extraction\.entry_id'
      or p.prosrc ~ 'source_document\.entry_id'
      or p.prosrc ~ 'coalesce\(\s*de\.entry_id'
    );

  if v_hits is not null then
    raise exception
      'Phase 6 blocked: these functions still reference the scalar entry_id columns -- finish Phase 4 first: %',
      v_hits;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Drop the temporary mirror trigger + its function.
-- ---------------------------------------------------------------------------
drop trigger if exists entry_bill_link_scalar_mirror on public.entry_bill_link;
drop function if exists private.sync_entry_bill_link_mirror();

-- ---------------------------------------------------------------------------
-- 2. Drop the scalar columns (RESTRICT -- aborts if a view still depends).
-- ---------------------------------------------------------------------------
drop index if exists public.document_extraction_entry_idx;
alter table public.document_extraction drop column entry_id;

drop index if exists public.source_document_entry_idx;
alter table public.source_document drop column entry_id;

-- The FK target added in Phase 1 for entry_bill_link_extraction_fk stays -- it
-- is still the pin that keeps a bill-grain link's source_document_id honest.
