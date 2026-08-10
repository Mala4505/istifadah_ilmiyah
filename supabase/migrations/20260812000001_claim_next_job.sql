-- claim_next_job (MASTER-PLAN §3.11)
--
-- lib/jobs/queue.ts calls `.rpc('claim_next_job', { p_worker_id })` and carries a
-- cross-reference comment asking for exactly this function. The claim itself is the
-- single statement from §3.11 verbatim -- `for update skip locked` is what makes it
-- safe across any number of concurrent workers on any number of machines.
--
-- Two functions, because `private` is deliberately never added to PostgREST's
-- `pgrst.db_schemas` (see 20260808000002_private_schema_and_helpers.sql): the real
-- implementation lives in `private` per the queue.ts cross-reference, and a thin
-- `public` wrapper is what the Data API can actually reach.

create or replace function private.claim_next_job(p_worker_id text)
returns setof public.job_queue
language sql
security definer
set search_path = ''
as $$
  update public.job_queue
     set status = 'running',
         locked_by = p_worker_id,
         locked_at = now(),
         attempts = attempts + 1
   where id = (
     select id from public.job_queue
      where status = 'queued' and run_after <= now()
      order by priority, id
      for update skip locked
      limit 1)
  returning *;
$$;

comment on function private.claim_next_job(text) is
  'Atomically claims the next runnable job_queue row for a worker (MASTER-PLAN §3.11). SKIP LOCKED means two concurrent workers never take the same job.';

-- PostgREST-callable wrapper. Same signature and return type, so
-- lib/jobs/queue.ts's `returns setof` array handling is unchanged.
create or replace function public.claim_next_job(p_worker_id text)
returns setof public.job_queue
language sql
security definer
set search_path = ''
as $$
  select * from private.claim_next_job(p_worker_id);
$$;

comment on function public.claim_next_job(text) is
  'Data API entry point for private.claim_next_job (MASTER-PLAN §3.11). service_role only -- the worker claims jobs with the secret key (§4.5).';

-- job_queue is pure background-worker infrastructure written exclusively by the
-- service_role worker (§4.5, and the RLS judgement call in
-- 20260808000026_rls_policies.sql, which gives `authenticated` a select-for-admins
-- policy and no write policy at all). A SECURITY DEFINER function bypasses RLS, so
-- execute has to be locked down explicitly rather than left on PUBLIC's default.
revoke execute on function private.claim_next_job(text) from public;
revoke execute on function public.claim_next_job(text) from public;
revoke execute on function public.claim_next_job(text) from anon, authenticated;
grant execute on function public.claim_next_job(text) to service_role;
