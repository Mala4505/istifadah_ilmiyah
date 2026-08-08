/**
 * `extract_document` job handler (MASTER-PLAN §3.11, §8).
 *
 * TODO Phase 1B: not implemented yet. Real implementation needs both the
 * `job_queue` / `claim_next_job` SQL (§3.11) and a real
 * `ANTHROPIC_API_KEY` (§6.4) in place — this is a stub with the correct
 * signature so `worker/index.ts` and the job-dispatch table can wire
 * against it today without lying about what it does.
 */

import type { JobQueueRow } from '@/lib/jobs/queue'

export async function handleExtractDocument(job: JobQueueRow): Promise<void> {
  void job
  throw new Error('not implemented — Phase 1B')
}

// worker/index.ts (and, eventually, app/api/jobs/tick/route.ts) dynamically
// import this module and call its default export — see the JobHandler
// contract documented there.
export default handleExtractDocument
