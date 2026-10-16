-- Pending-upload ledger (security-audit-fix-plan.md 4.3).
--
-- /api/documents/upload-url records every signed upload path it issues against
-- the user it was issued to; /api/documents/ingest then refuses to finalise a
-- path that was issued to somebody else. Only the server (service role) ever
-- touches this table: RLS is on, there are deliberately NO policies for
-- authenticated/anon, and every table privilege is revoked from them, so a
-- browser holding a user token can neither read nor forge a row.
--
-- The app tolerates this table not existing yet (it logs and falls back to the
-- old behaviour), so code can be deployed before this migration is pushed.

create table if not exists public.pending_upload (
  path       text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

comment on table public.pending_upload is
  'Signed upload paths issued by /api/documents/upload-url, keyed to the issuing user. Service-role only (no RLS policies on purpose).';

-- Lets a periodic cleanup of abandoned uploads range-scan by age, and backs the
-- cascade from auth.users deletes.
create index if not exists pending_upload_created_at_idx on public.pending_upload (created_at);
create index if not exists pending_upload_user_id_idx on public.pending_upload (user_id);

alter table public.pending_upload enable row level security;
alter table public.pending_upload force row level security;

revoke all on table public.pending_upload from anon, authenticated, public;
