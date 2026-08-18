import { describe, expect, it } from 'vitest'
import { nextPollBackoffMs, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_CAP_MS } from '@/lib/jobs/poll-backoff'

// plan.md Phase 3 I16: exponential-ish backoff between poll_batch re-polls,
// capped so a batch that legitimately takes up to 24h still gets checked
// periodically rather than being polled forever at the same short interval.

describe('nextPollBackoffMs', () => {
  it('starts at the base backoff on the first attempt', () => {
    expect(nextPollBackoffMs(1)).toBe(POLL_BACKOFF_BASE_MS)
    expect(nextPollBackoffMs(1)).toBe(30_000)
  })

  it('doubles on each successive attempt', () => {
    expect(nextPollBackoffMs(2)).toBe(60_000)
    expect(nextPollBackoffMs(3)).toBe(120_000)
    expect(nextPollBackoffMs(4)).toBe(240_000)
  })

  it('caps at POLL_BACKOFF_CAP_MS once doubling would exceed it', () => {
    expect(nextPollBackoffMs(5)).toBe(POLL_BACKOFF_CAP_MS)
    expect(nextPollBackoffMs(5)).toBe(300_000)
  })

  it('stays capped for arbitrarily many further attempts', () => {
    expect(nextPollBackoffMs(6)).toBe(POLL_BACKOFF_CAP_MS)
    expect(nextPollBackoffMs(50)).toBe(POLL_BACKOFF_CAP_MS)
    expect(nextPollBackoffMs(1000)).toBe(POLL_BACKOFF_CAP_MS)
  })

  it('treats zero or negative attempts as attempt 1 rather than producing an invalid backoff', () => {
    // job.attempts should never legitimately be 0 by the time a poll_batch
    // job reaches handlePollBatch (claim_next_job increments it before the
    // handler runs), but this keeps the function total and safe against a
    // malformed/pre-claim value rather than returning a negative or
    // near-zero delay.
    expect(nextPollBackoffMs(0)).toBe(POLL_BACKOFF_BASE_MS)
    expect(nextPollBackoffMs(-3)).toBe(POLL_BACKOFF_BASE_MS)
  })

  it('floors a fractional attempts value', () => {
    expect(nextPollBackoffMs(2.9)).toBe(nextPollBackoffMs(2))
  })

  it('never returns a value below the base or above the cap', () => {
    for (const attempt of [1, 2, 3, 4, 5, 10, 100]) {
      const ms = nextPollBackoffMs(attempt)
      expect(ms).toBeGreaterThanOrEqual(POLL_BACKOFF_BASE_MS)
      expect(ms).toBeLessThanOrEqual(POLL_BACKOFF_CAP_MS)
    }
  })
})
