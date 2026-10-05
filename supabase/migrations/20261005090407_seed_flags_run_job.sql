-- Seed the first flags_run job (docs/report-data-gaps-plan.md Phase 3).
--
-- lib/jobs/handlers/flags-run.ts re-queues itself after every run, but no
-- first job was ever inserted, so the sweep never started and `flags` is
-- empty. Insert one, guarded so re-running this migration (or running it
-- while a sweep is already queued/running) never stacks a second chain.

insert into public.job_queue (job_type, payload, status, run_after)
select 'flags_run', '{}'::jsonb, 'queued', now()
where not exists (
  select 1 from public.job_queue
   where job_type = 'flags_run'
     and status in ('queued', 'running')
);
