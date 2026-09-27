-- ============================================================================
-- Portal-scrape chunked uploads: a shared session id across the batches one
-- scrape gets split into (MASTER-PLAN §17.23 follow-up, 2026-09-27).
--
-- WHY THIS EXISTS
--
-- lib/import/run-portal-import.ts's runPortalImport does a handful of
-- round trips per row (resolver lookups on a cache miss, the entries upsert,
-- and -- since 2026-09-26 -- a SAVEPOINT/RELEASE pair to isolate one bad row
-- from poisoning the whole transaction). A large scrape (roughly 800+ rows)
-- pushes total wall time for ONE request well past what any serverless
-- function timeout allows, which is what actually sent an operator's dry run
-- back with a generic "Could not reach the server" instead of a real answer.
--
-- The fix is for the client (components/import/import-workspace.tsx) to
-- split one large scrape into several smaller HTTP requests ("chunks"),
-- each comfortably inside the request-timeout ceiling on its own. Each
-- chunk still gets its own public.import_batch row -- that bookkeeping is
-- unchanged and deliberately per-request, same as ingest_method='scrape'
-- always has been.
--
-- THE ONE THING CHUNKING BREAKS IF LEFT ALONE
--
-- detectMissingDepartmentalEntries (run-portal-import.ts) auto-voids any
-- open Hub entry, on this tab, that this scrape's rows do not mention --
-- the assumption being that "not mentioned" means "no longer on the
-- portal". That assumption is only true when the rows it is given are the
-- WHOLE scrape. Split naively into chunks, chunk 1 would see chunk 2's rows
-- as "missing" and auto-void entries that are simply sitting in a later
-- chunk -- a real, silent data-corrupting bug, not a hypothetical one.
--
-- scrape_session_id is what lets the server tell these two situations
-- apart: every chunk of one logical scrape is POSTed with the same
-- (client-generated) session id, and the auto-void check is deferred until
-- the request tagged as the final chunk, which then reads every batch
-- row sharing this session id (via scrape_payload_jsonb, already retained
-- per-batch since 20260814000005) and unions their rows before asking what
-- is missing. A non-chunked request (the bookmarklet, or any upload small
-- enough not to need splitting) never sets this column -- null here means
-- exactly what it always meant: "this one request is the whole scrape",
-- and the auto-void check runs immediately, unchanged from before this
-- migration.
alter table public.import_batch add column scrape_session_id text;

-- Partial index: only chunked uploads ever populate this column, and the
-- only query against it ("every batch in this session") only ever runs for
-- those. Matches this table's existing import_batch_imported_by_idx
-- convention of a partial index scoped to the rows that actually use the
-- column (20260808000011).
create index import_batch_scrape_session_idx on public.import_batch (scrape_session_id)
  where scrape_session_id is not null;

comment on column public.import_batch.scrape_session_id is
  'Client-generated id shared by every chunk of one large portal scrape split across several requests. Null for a non-chunked import. See this migration''s header for why the auto-void check keys off it.';
