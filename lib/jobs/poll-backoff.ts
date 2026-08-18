/**
 * Backoff scheduling for `poll_batch` re-polls (plan.md Phase 3 I16).
 *
 * Its own tiny, dependency-free module for the same reason as
 * lib/jobs/batch-custom-id.ts: this logic is pure, but lib/jobs/queue.ts
 * (where `requeueJob` actually applies this) transitively imports
 * lib/env.server.ts, which imports the `server-only` sentinel package —
 * that throws on import outside Next.js's `react-server` resolve condition,
 * which includes the vitest unit-test environment. Keeping the pure
 * calculation here, free of any `server-only`-tainted import, is what makes
 * it unit-testable (see test/unit/poll-backoff.test.ts).
 */

/** 30s, doubling each poll, capped at 5 minutes. */
export const POLL_BACKOFF_BASE_MS = 30_000
export const POLL_BACKOFF_CAP_MS = 5 * 60_000

/**
 * Backoff before the next poll of a still-processing batch, keyed by how
 * many times this `poll_batch` job row has been claimed so far
 * (`JobQueueRow.attempts`, incremented by `claim_next_job` on every claim —
 * see the claim SQL documented at the top of lib/jobs/queue.ts — so the
 * first claim is attempt 1, conveniently requiring no separate counter in
 * the job's payload).
 *
 * 30s / 60s / 120s / 240s / 300s(capped) / 300s / ... — quick enough to
 * catch a batch that finishes in well under a minute (common for a single
 * small request), capped low enough that a genuinely ~24h-long wait still
 * checks a few hundred times, not never, without hammering the Batches API
 * every few seconds for a day.
 */
export function nextPollBackoffMs(attempts: number): number {
  const attempt = Math.max(1, Math.floor(attempts))
  const backoff = POLL_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
  return Math.min(backoff, POLL_BACKOFF_CAP_MS)
}
