-- Phase 0 §0.3 (docs/pre-deploy-findings-and-plan.md) -- ten open exceptions
-- are raised at ingest/extraction time (duplicate_document_hash,
-- page_count_unresolved from app/api/documents/ingest/route.ts;
-- page_count_mismatch, page_extraction_failed from
-- lib/jobs/handlers/extract.ts) with entry_id, document_extraction_id AND
-- import_batch_id all null -- the document they're about is named only
-- inside free-text `description`. That makes them permanently unattributable
-- to an event (v_open_issues' coalesce chain has nothing to resolve through)
-- and unreachable from the document's own page. Add a fourth, direct link.

alter table public.reconciliation_exception
  add column source_document_id bigint references public.source_document(id) on delete cascade;

-- Same partial-index pattern as the other three nullable FKs on this table
-- (20260808000023): most rows never populate this column, so a plain index
-- would be mostly dead weight -- narrow it to the rows that do.
create index recon_exception_source_document_idx on public.reconciliation_exception (source_document_id)
  where source_document_id is not null;

-- ----------------------------------------------------------------------------
-- Backfill. Parsed from `dedup_key`, not `description` -- description text is
-- NOT a reliable source for this: duplicate_document_hash's description
-- reads "...same SHA-256 as source_document {duplicateOf}" (the EARLIER
-- document being matched against), while the exception row itself belongs to
-- the newly-uploaded document (dedup_key is
-- `duplicate_document_hash:{fileHash}:{documentId}`, keyed on the new
-- document's id). A naive `source_document (\d+)` regex over description
-- would silently attribute every duplicate_document_hash row to the wrong
-- document -- the same class of trap 20260822000004's header warns about
-- (build backfill/constraint logic from what the live code actually writes,
-- not a plausible-looking guess). dedup_key is deterministic per raise site
-- and always carries the correct id, so it's the accurate source here.
--
-- Covers all four raise sites that write these exceptions with no entry_id /
-- document_extraction_id / import_batch_id:
--   duplicate_document_hash : dedup_key = 'duplicate_document_hash:{hash}:{documentId}'
--   page_count_unresolved   : dedup_key = 'page_count_unresolved:{documentId}'
--   page_count_mismatch     : dedup_key = 'page_count_mismatch:{sourceDocumentId}:{runId}'
--   page_extraction_failed  : dedup_key = 'page_extraction_failed:{sourceDocumentId}:{pageNumber}'
--
-- Every update is guarded with `exists (select 1 from source_document ...)`,
-- not just a regexp match -- live data has at least one duplicate_document_hash
-- row whose parsed id (a hard delete target, per 20260820000001's
-- delete-source-document flow) no longer exists in source_document. The FK
-- added above would reject an update to a dangling id outright (23503), and
-- silently would be worse: a row genuinely can't be attributed to a document
-- that no longer exists, so it correctly stays source_document_id = null
-- (same "unresolvable, stays visible, never dropped" contract §0.1 set for
-- the app-layer event resolution).
-- ----------------------------------------------------------------------------

update public.reconciliation_exception re
set source_document_id = m.doc_id
from (
  select id, (regexp_match(dedup_key, '^duplicate_document_hash:[^:]+:(\d+)$'))[1]::bigint as doc_id
  from public.reconciliation_exception
  where exception_type = 'duplicate_document_hash'
    and source_document_id is null
    and dedup_key ~ '^duplicate_document_hash:[^:]+:(\d+)$'
) m
where re.id = m.id
  and exists (select 1 from public.source_document sd where sd.id = m.doc_id);

update public.reconciliation_exception re
set source_document_id = m.doc_id
from (
  select id, (regexp_match(dedup_key, '^page_count_unresolved:(\d+)$'))[1]::bigint as doc_id
  from public.reconciliation_exception
  where exception_type = 'page_count_unresolved'
    and source_document_id is null
    and dedup_key ~ '^page_count_unresolved:(\d+)$'
) m
where re.id = m.id
  and exists (select 1 from public.source_document sd where sd.id = m.doc_id);

update public.reconciliation_exception re
set source_document_id = m.doc_id
from (
  select id, (regexp_match(dedup_key, '^page_count_mismatch:(\d+):\d+$'))[1]::bigint as doc_id
  from public.reconciliation_exception
  where exception_type = 'page_count_mismatch'
    and source_document_id is null
    and dedup_key ~ '^page_count_mismatch:(\d+):\d+$'
) m
where re.id = m.id
  and exists (select 1 from public.source_document sd where sd.id = m.doc_id);

update public.reconciliation_exception re
set source_document_id = m.doc_id
from (
  select id, (regexp_match(dedup_key, '^page_extraction_failed:(\d+):\d+$'))[1]::bigint as doc_id
  from public.reconciliation_exception
  where exception_type = 'page_extraction_failed'
    and source_document_id is null
    and dedup_key ~ '^page_extraction_failed:(\d+):\d+$'
) m
where re.id = m.id
  and exists (select 1 from public.source_document sd where sd.id = m.doc_id);

-- Fallback for anything the four patterns above didn't catch (a hand-inserted
-- row, or a dedup_key that doesn't follow the current convention): parse
-- "source_document {id}" out of description directly. Excludes
-- duplicate_document_hash explicitly -- see the header comment above for why
-- that type's description names the wrong document. Same exists-guard as above.
update public.reconciliation_exception re
set source_document_id = m.doc_id
from (
  select id, (regexp_match(description, 'source_document (\d+)'))[1]::bigint as doc_id
  from public.reconciliation_exception
  where source_document_id is null
    and entry_id is null
    and document_extraction_id is null
    and import_batch_id is null
    and exception_type <> 'duplicate_document_hash'
    and description ~ 'source_document (\d+)'
) m
where re.id = m.id
  and exists (select 1 from public.source_document sd where sd.id = m.doc_id);

-- ----------------------------------------------------------------------------
-- v_open_issues -- add source_document_id as a fourth, last-resort link in the
-- event-resolution coalesce chain (base definition: 20260814000007; event_id
-- output column added by 20260822000007). Column list is unchanged (only the
-- event_id expression's join/coalesce logic changes), so CREATE OR REPLACE is
-- safe here -- no column reorder/removal, and it preserves the existing grant
-- (20260822000007's drop-and-recreate needed to re-grant explicitly only
-- because it changed the column list).
-- ----------------------------------------------------------------------------
create or replace view public.v_open_issues with (security_invoker = true) as
select * from (
  select
    'reconciliation_exception'::text as source_table,
    re.id,
    re.entry_id,
    re.exception_type as issue_type,
    re.severity,
    re.amount_at_risk,
    re.description,
    re.status,
    re.created_at,
    coalesce(re_e.event_id, re_sd.event_id, re_ib.event_id, re_sd_direct.event_id) as event_id
  from public.reconciliation_exception re
  left join public.entries re_e on re_e.id = re.entry_id
  left join public.document_extraction re_de on re_de.id = re.document_extraction_id
  left join public.source_document re_sd on re_sd.id = re_de.source_document_id
  left join public.import_batch re_ib on re_ib.id = re.import_batch_id
  left join public.source_document re_sd_direct on re_sd_direct.id = re.source_document_id
  where re.status = 'open'
  union all
  select
    'flags'::text as source_table,
    f.id,
    f.entry_id,
    f.flag_type as issue_type,
    f.severity,
    f.amount_at_risk,
    f.description,
    f.status,
    f.created_at,
    f_e.event_id
  from public.flags f
  left join public.entries f_e on f_e.id = f.entry_id
  where f.status = 'open'
) combined
order by
  case severity when 'high' then 1 when 'medium' then 2 when 'low' then 3 else 4 end,
  amount_at_risk desc nulls last;
