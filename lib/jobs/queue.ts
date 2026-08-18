/**
 * Job queue client (MASTER-PLAN §3.11, §4.5).
 *
 * The app never opens a raw Postgres connection (§4.5) — it always goes
 * through Supabase's Data API. That means the exact claim statement from
 * §3.11:
 *
 *   update public.job_queue
 *      set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
 *    where id = (
 *      select id from public.job_queue
 *       where status = 'queued' and run_after <= now()
 *       order by priority, id
 *       for update skip locked
 *       limit 1)
 *   returning *;
 *
 * cannot be sent as raw SQL from here — it has to be wrapped in a
 * SECURITY DEFINER Postgres function that the Data API can call via
 * `.rpc(...)`.
 *
 * >>> Cross-reference for the SQL migrations agent (or a human): please add
 * >>>   create function private.claim_next_job(p_worker_id text)
 * >>>   returns setof public.job_queue
 * >>>   language sql security definer
 * >>>   as $$ <the statement above, with $1 replaced by p_worker_id> $$;
 * >>> exposed to PostgREST as `claim_next_job` (either by putting the
 * >>> callable wrapper in the exposed `public` schema, or by exposing the
 * >>> `private` schema per whatever convention lib/supabase/* already uses
 * >>> for other `private.*` helpers — see §4.1). This file is written
 * >>> assuming that RPC function exists under the name `claim_next_job`;
 * >>> it does not block on the SQL agent having added it yet.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { publicEnv } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'
export { nextPollBackoffMs, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS } from '@/lib/jobs/poll-backoff'

export type JobType =
  | 'extract_document'
  | 'poll_batch'
  | 'generate_export'
  | 'rasterize_retry'
  | 'flags_run'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead'

/** Mirrors `public.job_queue` (§3.11) column-for-column. */
export interface JobQueueRow {
  id: number
  job_type: JobType
  payload: Record<string, unknown>
  status: JobStatus
  priority: number
  attempts: number
  max_attempts: number
  run_after: string
  locked_by: string | null
  locked_at: string | null
  last_error: string | null
  created_at: string
  completed_at: string | null
}

let cachedClient: SupabaseClient | null = null

/** Lazily constructed so importing this file never throws before it's actually used. */
function getClient(): SupabaseClient {
  if (!cachedClient) {
    cachedClient = createClient(publicEnv.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }
  return cachedClient
}

function isJobQueueRow(value: unknown): value is JobQueueRow {
  return typeof value === 'object' && value !== null && 'id' in value && 'job_type' in value
}

/**
 * Claims the next queued job for `workerId` via the `claim_next_job` RPC
 * (see the cross-reference comment above). Returns `null` when the queue
 * is empty — this is the normal, expected outcome of an empty poll, not an
 * error.
 */
export async function claimNextJob(workerId: string): Promise<JobQueueRow | null> {
  const client = getClient()
  const { data, error } = await client.rpc('claim_next_job', { p_worker_id: workerId })

  if (error) {
    throw new Error(`claimNextJob(${workerId}) failed: ${error.message}`)
  }

  // A SECURITY DEFINER function declared `returns setof public.job_queue`
  // comes back as an array over the Data API; handle a single-row shape
  // defensively too in case it's ever declared `returns public.job_queue`.
  const candidate: unknown = Array.isArray(data) ? data[0] : data
  return isJobQueueRow(candidate) ? candidate : null
}

/** Marks a job `succeeded` and stamps `completed_at`. */
export async function completeJob(id: number): Promise<void> {
  const client = getClient()
  const { error } = await client
    .from('job_queue')
    .update({ status: 'succeeded', completed_at: new Date().toISOString() })
    .eq('id', id)

  if (error) {
    throw new Error(`completeJob(${id}) failed: ${error.message}`)
  }
}

/**
 * Marks a job `failed` and records `last_error`. Retry/backoff and the
 * eventual transition to `dead` after `max_attempts` (§3.11) are handled by
 * the sweeper (`sweepJobQueue`, below), not here — this just records what
 * happened on this attempt.
 */
export async function failJob(id: number, error: string): Promise<void> {
  const client = getClient()
  const { error: updateError } = await client
    .from('job_queue')
    .update({ status: 'failed', last_error: error })
    .eq('id', id)

  if (updateError) {
    throw new Error(`failJob(${id}) failed: ${updateError.message}`)
  }
}

/**
 * Releases a claimed job back to `'queued'` for a later `run_after`, without
 * treating this claim cycle as a failure (plan.md Phase 3 I16). Used by
 * `handlePollBatch` (lib/jobs/handlers/batch-poll.ts) when a Message Batch is
 * still processing — checked for first because nothing suitable already
 * existed: `failJob` is the wrong tool here, since it moves the row to
 * `'failed'`, and `sweepJobQueue`'s dead-lettering only inspects
 * `'running'`/`'failed'` rows that have exhausted `max_attempts` (today 3).
 * A Message Batch can legitimately take up to 24h to finish, which is far
 * more than 3 poll cycles — routing "still processing" through `failJob`
 * would dead-letter every batch before it ever completes. Going straight
 * back to `'queued'` (never through `'failed'`) means `sweepJobQueue` never
 * touches this row while it waits, no matter how many times it's polled.
 *
 * Pass the next `run_after` computed by `nextPollBackoffMs`
 * (lib/jobs/poll-backoff.ts, re-exported above) — kept in its own
 * dependency-free module rather than defined here so it can be unit-tested
 * without pulling in this file's `server-only`-tainted Supabase client.
 */
export async function requeueJob(id: number, runAfter: Date): Promise<void> {
  const client = getClient()
  const { error } = await client
    .from('job_queue')
    .update({
      status: 'queued',
      run_after: runAfter.toISOString(),
      locked_by: null,
      locked_at: null,
    })
    .eq('id', id)

  if (error) {
    throw new Error(`requeueJob(${id}) failed: ${error.message}`)
  }
}

/** Summary counts returned by the `sweep_job_queue` RPC. */
export interface SweepJobQueueResult {
  reclaimedCount: number
  deadenedCount: number
  purgedCount: number
}

function isSweepJobQueueRow(
  value: unknown
): value is { reclaimed_count: number; deadened_count: number; purged_count: number } {
  return typeof value === 'object' && value !== null && 'reclaimed_count' in value
}

/**
 * Runs the job-queue sweep (plan.md Phase 3 I15, `private.sweep_job_queue`
 * in 20260817000007_sweep_job_queue.sql): reclaims stale-`running` and
 * `failed` rows back to `queued` with exponential backoff, deadens rows
 * whose `attempts` have exhausted `max_attempts`, and purges `succeeded`
 * rows older than 30 days. Safe to call repeatedly and concurrently — the
 * SQL function uses `for update skip locked` the same way `claim_next_job`
 * does, so the Vercel Cron tick and the standalone worker can both call this
 * without double-processing a row.
 */
export async function sweepJobQueue(): Promise<SweepJobQueueResult> {
  const client = getClient()
  const { data, error } = await client.rpc('sweep_job_queue')

  if (error) {
    throw new Error(`sweepJobQueue() failed: ${error.message}`)
  }

  // A SECURITY DEFINER function declared `returns table (...)` comes back as
  // an array of one row over the Data API; handle a bare-object shape
  // defensively too, mirroring claimNextJob's handling above.
  const candidate: unknown = Array.isArray(data) ? data[0] : data
  if (!isSweepJobQueueRow(candidate)) {
    throw new Error('sweepJobQueue() returned an unexpected shape')
  }

  return {
    reclaimedCount: candidate.reclaimed_count,
    deadenedCount: candidate.deadened_count,
    purgedCount: candidate.purged_count,
  }
}
