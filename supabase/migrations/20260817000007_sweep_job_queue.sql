-- sweep_job_queue (MASTER-PLAN §3.11, plan.md Phase 3 I15)
--
-- 20260808000025_flags.sql's closing comment describes the intended behaviour
-- verbatim: "A job stuck in 'running' past a timeout is reclaimed by a
-- sweeper and retried with exponential backoff on run_after; after
-- max_attempts it goes 'dead'. succeeded rows are swept 30 days later." That
-- comment was written before the sweeper existed. worker/index.ts's dispatch()
-- and app/api/jobs/tick/route.ts's dispatch() both already lean on it: the
-- 'generate_export'/'rasterize_retry' job types have no handler yet, so those
-- rows are deliberately left 'running'/locked forever rather than marked
-- failed for a handler that was never attempted -- this function is what
-- reclaims them instead of leaving them stuck permanently.
--
-- Three responsibilities in one call, matching the flags.sql comment plus the
-- one gap it leaves open (what happens to 'failed' rows):
--
--   1. Reclaim stale 'running' rows (locked_at older than the staleness
--      timeout below -- a crashed worker, or the no-handler-yet stub path)
--      back to 'queued', with exponential backoff on run_after.
--   2. 'failed' rows: lib/jobs/queue.ts's failJob() doc comment already says
--      retry/backoff and the eventual dead transition are "handled by the
--      sweeper, not here". Nothing else in the codebase ever requeues a
--      'failed' row today, which would make max_attempts (default 3)
--      meaningless -- a job that throws once would stay failed forever
--      after consuming exactly one of its three attempts. claim_next_job
--      (20260812000001) increments `attempts` at claim time, before the
--      handler runs, so a 'failed' row's `attempts` already reflects that
--      consumed attempt; the sweeper only needs to flip status/run_after,
--      never touch attempts itself. So: stale-running rows and failed rows
--      are treated identically once each attempt is used up -- requeue if
--      attempts < max_attempts, otherwise transition to 'dead'.
--   3. Delete 'succeeded' rows whose completed_at is more than 30 days old
--      (per the flags.sql comment, "succeeded rows are swept 30 days later").
--
-- Staleness timeout: 10 minutes. lib/claude-client.ts's extraction call runs
-- at EXTRACTION_MAX_TOKENS=4000, with a truncation-retry path that re-sends
-- the full PDF at TRUNCATION_RETRY_MAX_TOKENS=8000 on top of the first call --
-- so one job can, in the worst case, involve two sequential Claude API calls
-- against a large PDF plus Postgres writes. Even generously (large PDF,
-- network hiccups, a slow truncation retry) that's very unlikely to clear a
-- few minutes; 10 minutes leaves comfortable headroom above the realistic
-- worst case while still being short enough that a crashed worker's job
-- doesn't sit locked for hours before the next sweep finds it.
--
-- Backoff: least(2^attempts, 60) minutes, uncapped at the low end and capped
-- at an hour so a job type with a much larger max_attempts than today's
-- default of 3 can't spin the sweeper into requeuing it every few seconds
-- forever. With max_attempts=3 (today's only value in use), a row only ever
-- gets swept back to 'queued' at attempts=1 (2 min backoff) or attempts=2 (4
-- min backoff); at attempts=3 it goes straight to 'dead'.
--
-- FOR UPDATE SKIP LOCKED, same pattern as private.claim_next_job, so the
-- Vercel Cron tick and the standalone worker process can both call this
-- concurrently without double-processing the same row.

create or replace function private.sweep_job_queue()
returns table (reclaimed_count int, deadened_count int, purged_count int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stale_timeout constant interval := interval '10 minutes';
  v_succeeded_retention constant interval := interval '30 days';
  v_reclaimed int := 0;
  v_deadened int := 0;
  v_purged int := 0;
begin
  -- 1. Rows whose attempts are exhausted -- whether stuck 'running' past the
  -- staleness timeout or already 'failed' -- go to 'dead'. Done first so the
  -- requeue step below never has to re-check attempts against a row this
  -- step already claimed.
  with dead as (
    update public.job_queue
       set status = 'dead',
           locked_by = null,
           locked_at = null
     where id in (
       select id from public.job_queue
        where ((status = 'running' and locked_at < now() - v_stale_timeout)
               or status = 'failed')
          and attempts >= max_attempts
        for update skip locked)
    returning id
  )
  select count(*) into v_deadened from dead;

  -- 2. Everything else stuck 'running' past the timeout, or 'failed', with
  -- attempts remaining: back to 'queued' with exponential backoff.
  with requeued as (
    update public.job_queue
       set status = 'queued',
           locked_by = null,
           locked_at = null,
           run_after = now() + (least(power(2, attempts)::int, 60) * interval '1 minute')
     where id in (
       select id from public.job_queue
        where ((status = 'running' and locked_at < now() - v_stale_timeout)
               or status = 'failed')
          and attempts < max_attempts
        for update skip locked)
    returning id
  )
  select count(*) into v_reclaimed from requeued;

  -- 3. Purge old succeeded rows.
  with purged as (
    delete from public.job_queue
     where id in (
       select id from public.job_queue
        where status = 'succeeded' and completed_at < now() - v_succeeded_retention
        for update skip locked)
    returning id
  )
  select count(*) into v_purged from purged;

  return query select v_reclaimed, v_deadened, v_purged;
end;
$$;

comment on function private.sweep_job_queue() is
  'Reclaims stale-running and failed job_queue rows with backoff (or deadens them past max_attempts) and purges old succeeded rows (MASTER-PLAN §3.11, plan.md Phase 3 I15).';

-- PostgREST-callable wrapper, same pattern as public.claim_next_job.
create or replace function public.sweep_job_queue()
returns table (reclaimed_count int, deadened_count int, purged_count int)
language sql
security definer
set search_path = ''
as $$
  select * from private.sweep_job_queue();
$$;

comment on function public.sweep_job_queue() is
  'Data API entry point for private.sweep_job_queue (MASTER-PLAN §3.11, plan.md Phase 3 I15). service_role only, same as claim_next_job (§4.5) -- called from app/api/jobs/tick/route.ts and worker/index.ts.';

-- Same lockdown as claim_next_job: SECURITY DEFINER bypasses RLS, so execute
-- must be revoked from PUBLIC/anon/authenticated explicitly and granted only
-- to the service_role worker.
revoke execute on function private.sweep_job_queue() from public;
revoke execute on function public.sweep_job_queue() from public;
revoke execute on function public.sweep_job_queue() from anon, authenticated;
grant execute on function public.sweep_job_queue() to service_role;
