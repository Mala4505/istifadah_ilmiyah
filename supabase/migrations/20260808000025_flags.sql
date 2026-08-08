-- Schema only in week 1. The engine is week 2 (§12, §3.10).
create table public.flags (
  id bigint generated always as identity primary key,
  flag_type text not null check (flag_type in
    ('vendor_cluster','duplicate_payment','rate_drift','discount_inconsistency','missing_documentation')),
  entry_id bigint references public.entries(id),
  related_entry_ids bigint[],
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  description text not null,
  amount_at_risk numeric(14,2),
  dedup_key text not null unique,
  status text not null default 'open' check (status in ('open','confirmed','dismissed')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  detected_by_run text,
  created_at timestamptz not null default now()
);
create index flags_open_idx on public.flags (status, severity, amount_at_risk desc) where status = 'open';
create index flags_entry_idx on public.flags (entry_id) where entry_id is not null;
create index flags_resolved_by_idx on public.flags (resolved_by) where resolved_by is not null;

-- JUDGEMENT CALL: public.job_queue (§3.11) has no dedicated migration file in §10's
-- file list -- the list jumps straight from 25_flags to 26_rls_policies, even though
-- §3.11 defines the table with its own indexes and 20260808000026's RLS rollout is
-- explicitly required to cover it. job_queue has zero foreign keys (payload is a plain
-- jsonb blob) so it has no ordering dependency on any other table; it is appended here,
-- to the last plain table-creation file before security is layered on in 026/027/028,
-- rather than invented as a 29th file outside the exact list the task specified.
create table public.job_queue (
  id bigint generated always as identity primary key,
  job_type text not null check (job_type in
    ('extract_document','poll_batch','generate_export','rasterize_retry')),
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','dead')),
  priority int not null default 100,          -- lower runs first
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),   -- backoff and scheduling
  locked_by text,                                  -- worker instance id
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index job_queue_claim_idx on public.job_queue (status, run_after, priority)
  where status = 'queued';
create index job_queue_stale_idx on public.job_queue (locked_at) where status = 'running';

-- Claiming is a single statement, safe across any number of concurrent workers on any
-- number of machines (§3.11):
--
--   update public.job_queue
--      set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
--    where id = (
--      select id from public.job_queue
--       where status = 'queued' and run_after <= now()
--       order by priority, id
--       for update skip locked
--       limit 1)
--   returning *;
--
-- FOR UPDATE SKIP LOCKED is ordinary Postgres -- no extension, no Supabase feature, no
-- vendor lock. A job stuck in 'running' past a timeout is reclaimed by a sweeper and
-- retried with exponential backoff on run_after; after max_attempts it goes 'dead'.
-- succeeded rows are swept 30 days later, per §4.4d.
