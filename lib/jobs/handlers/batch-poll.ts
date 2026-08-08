/**
 * `poll_batch` job handler (MASTER-PLAN §3.11, §8 point 8).
 *
 * TODO Phase 1B: not implemented yet. The Batch API path (submit, poll by
 * `custom_id` — results arrive in any order, never keyed by position — and
 * write into `ocr_extraction_run` / `document_extraction`) needs both the
 * `job_queue` SQL (§3.11) and a real `ANTHROPIC_API_KEY` (§6.4) in place.
 * This is a stub with the correct signature so `worker/index.ts` and the
 * job-dispatch table can wire against it today without lying about what it
 * does. See the `// TODO Phase 1B` note in `lib/claude-client.ts` for where
 * the Batch API wrapper itself will live.
 */

import type { JobQueueRow } from '@/lib/jobs/queue'

export async function handlePollBatch(job: JobQueueRow): Promise<void> {
  void job
  throw new Error('not implemented — Phase 1B')
}

// worker/index.ts (and, eventually, app/api/jobs/tick/route.ts) dynamically
// import this module and call its default export — see the JobHandler
// contract documented there.
export default handlePollBatch
