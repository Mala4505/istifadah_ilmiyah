-- Adds the job type flags-run needs to enqueue itself (job_queue.job_type
-- currently only knows about the four types listed in §3.11: extract_document,
-- poll_batch, generate_export, rasterize_retry).
--
-- flags-run is a whole-corpus sweep, not a per-document job, so it has no
-- natural triggering event the way extract_document has "a document was
-- uploaded". It makes itself recurring instead: the handler re-inserts its own
-- next run with run_after pushed into the future before it marks itself
-- succeeded (lib/jobs/handlers/flags-run.ts). That reuses the exact claim
-- mechanism §3.11 already defined (FOR UPDATE SKIP LOCKED on run_after <= now())
-- rather than inventing a second scheduling system alongside it.
alter table public.job_queue drop constraint job_queue_job_type_check;
alter table public.job_queue add constraint job_queue_job_type_check
  check (job_type in ('extract_document','poll_batch','generate_export','rasterize_retry','flags_run'));

-- Seeds the first run. After this, the handler re-queues itself
-- (lib/jobs/handlers/flags-run.ts scheduleNextRun) — nothing else ever needs
-- to insert a flags_run row again.
insert into public.job_queue (job_type, payload, run_after)
values ('flags_run', '{}'::jsonb, now());
