-- ============================================================================
-- Phase 3 — two-way integration, part 1: portal scrape ingest
-- (MASTER-PLAN §14 Phase 3 item 1, §17.23)
--
-- Everything here supports one new ingest path: a bookmarklet reads a portal's
-- on-screen table from the operator's own logged-in tab and POSTs it to
-- /api/import/portal. No credentials for either portal are ever stored
-- server-side -- that is the entire point of the bookmarklet approach (§17.23).
-- ============================================================================

-- ---- 1. entry_status: uniqueness is per source system, not global ----------
-- entry_status.code carried a GLOBAL unique constraint, which was harmless
-- while only the Departmental side imported: its three observed codes
-- ('pending', 'sent_main', 'approved') happen not to collide. The Audit portal
-- renders 'Paid' and 'Tax Invoice Upload Pending (Paid)', and the Departmental
-- portal is expected to render an overlapping vocabulary -- confirmed
-- 2026-08-12 ("the statuses are kind of the same"). Under a global unique
-- constraint the first side to import a shared label wins the row, and the
-- other side's status then silently resolves to a row tagged with the WRONG
-- source_system: an Audit 'paid' would read back as a Departmental status.
--
-- The same-name-different-system case is legitimate, so the key becomes
-- (code, source_system). run-import.ts's resolveStatus is updated in the same
-- change to look up on both columns; looking up on code alone against this
-- constraint would still return the wrong row.
--
-- Safe to swap without a data fix: the three seeded rows are distinct codes.
alter table public.entry_status drop constraint if exists entry_status_code_key;
alter table public.entry_status add constraint entry_status_code_source_key
  unique (code, source_system);

-- ---- 2. import_batch: where the rows came from -----------------------------
-- A scraped batch has no file. `source_filename` and `file_hash_sha256` stay
-- NOT NULL and are still populated -- the filename becomes a synthetic label
-- ("audit-portal-scrape") and the hash is taken over the canonicalised JSON
-- payload, which preserves exactly the property the column exists for:
-- re-submitting an identical table produces an identical hash, so a duplicate
-- scrape is recognisable. `ingest_method` is what actually distinguishes the
-- paths, so the import history screen can say how a batch arrived.
alter table public.import_batch add column ingest_method text not null default 'file'
  check (ingest_method in ('file','scrape','api'));

-- The scraped payload exactly as received, before any mapping. The .xlsx path
-- has the original file to fall back on when a mapping turns out wrong; the
-- scrape path has nothing unless it is kept here. Same 24-month retention
-- reasoning as import_row_log.raw_row_jsonb (§4.4d).
alter table public.import_batch add column scrape_payload_jsonb jsonb;

-- The portal page the rows were read from, for provenance when two portals
-- render the same-shaped table.
alter table public.import_batch add column source_url text;

-- ---- 3. import_row_log: the actions the Audit path produces ----------------
-- The Audit side does not create entries -- it annotates entries the
-- Departmental import already created. Its outcomes are therefore a different
-- vocabulary from insert/update/unchanged, and the existing check constraint
-- rejects them.
alter table public.import_row_log drop constraint if exists import_row_log_action_check;
alter table public.import_row_log add constraint import_row_log_action_check
  check (action in (
    -- existing (Departmental .xlsx path)
    'inserted','updated','unchanged','skipped_header','skipped_total',
    'skipped_no_ubbl','new_budget_head','new_vendor','error',
    -- Phase 3 (portal scrape / Audit path)
    'audit_status_updated',   -- matched an entry; audit_status_id written
    'audit_status_unchanged', -- matched an entry; audit status already correct
    'audit_unmatched',        -- no Hub entry corresponds to this Audit row
    'audit_ambiguous',        -- more than one Hub entry matched; nothing written
    'skipped_no_identifier'   -- neither a UBBL nor a Main number in the row
  ));

-- ---- 4. reconciliation_exception: the Audit path's findings ----------------
-- 'tenant_vs_main_variance' already exists and is the right type for a matched
-- row whose amount disagrees, so it is reused rather than duplicated. The two
-- added types have no existing equivalent.
alter table public.reconciliation_exception drop constraint if exists reconciliation_exception_exception_type_check;
alter table public.reconciliation_exception add constraint reconciliation_exception_exception_type_check
  check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_tenant_amount','tenant_vs_main_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other',
    -- Phase 3
    'audit_row_unmatched',    -- an Audit entry the Hub has never seen
    'audit_ambiguous_match'   -- an Audit row matching two or more Hub entries
  ));

-- ---- 5. entries: when the Audit side last spoke ----------------------------
-- entries.audit_status_changed_at/_by already exist (20260811000003) but are
-- Hub-actor columns -- `_by` is a uuid referencing auth.users, which a portal
-- scrape has no value for. These record the machine-side provenance instead,
-- so "the Audit portal said this on the 12th" survives independently of who
-- ran the import.
alter table public.entries add column audit_synced_at timestamptz;
alter table public.entries add column audit_sync_batch_id bigint references public.import_batch(id);
create index entries_audit_sync_batch_idx on public.entries (audit_sync_batch_id)
  where audit_sync_batch_id is not null;

-- ---- 6. scrape_token -------------------------------------------------------
-- A short-lived bearer credential the operator pastes into the bookmarklet
-- once. It exists because the bookmarklet runs on the PORTAL's origin, so the
-- Hub's session cookie is not sent with its request (SameSite, and a
-- cross-origin fetch would not carry it in any case).
--
-- WHY A DEDICATED TOKEN AND NOT THE SUPABASE SESSION JWT: a bookmarklet's
-- token is pasted into a page the Hub does not control, so it must be
-- narrow -- this one authorises exactly one thing (submit a scraped table) and
-- nothing else, expires in hours, and can be revoked without touching the
-- operator's login. Handing a portal page a Supabase access token would give
-- that page the operator's full Data-API rights.
--
-- Only a SHA-256 hash of the token is stored. A leaked database dump therefore
-- yields no usable tokens, and the plaintext exists only in the operator's
-- clipboard and the bookmarklet's own storage.
create table public.scrape_token (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  -- First 8 characters of the plaintext, shown in the UI so the operator can
  -- tell two live tokens apart without either being recoverable.
  token_prefix text not null,
  label text,
  source_system text not null check (source_system in ('departmental','audit')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz,
  use_count int not null default 0,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id)
);
create index scrape_token_created_by_idx on public.scrape_token (created_by);
-- Matches the codebase's existing convention for actor-tracking FK columns
-- (e.g. reconciliation_exception.resolved_by / recon_exception_resolved_by_idx,
-- 20260808000023) -- indexed so a future "who revoked this" admin view or
-- audit join isn't a sequential scan, and per the FK-indexing rule generally
-- (Postgres never indexes a foreign key column automatically).
create index scrape_token_revoked_by_idx on public.scrape_token (revoked_by)
  where revoked_by is not null;
-- Partial index over the live tokens only: verification looks up by hash and
-- then checks liveness, and the live set stays tiny.
create index scrape_token_live_idx on public.scrape_token (expires_at)
  where revoked_at is null;

alter table public.scrape_token enable row level security;
alter table public.scrape_token force row level security;

-- Admins can see and revoke tokens (running an import is admin-only, §4.4c, so
-- minting the credential that submits one is too). Verification and use happen
-- in a Route Handler over the direct/secret-keyed connection, which bypasses
-- RLS -- hence no insert policy here, matching import_batch's own comment.
create policy scrape_token_select on public.scrape_token for select to authenticated
  using ((select private.is_admin()));

create policy scrape_token_update on public.scrape_token for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));

comment on table public.scrape_token is
  'Short-lived bearer tokens for the portal-scrape bookmarklet (MASTER-PLAN §17.23). Hash-only storage; plaintext is shown once at creation and never again.';
