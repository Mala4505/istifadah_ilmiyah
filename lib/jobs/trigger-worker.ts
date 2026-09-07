import 'server-only'
import * as Sentry from '@sentry/nextjs'
import { serverEnv } from '@/lib/env.server'

/**
 * Best-effort nudge to the GitHub Actions worker
 * (.github/workflows/worker.yml) to start draining the queue immediately,
 * rather than leaving a freshly-enqueued job to wait for that workflow's next
 * scheduled safety-net run.
 *
 * Why this exists: on Vercel Hobby the platform hard-kills any function at
 * ~10s, so neither the upload route (INGEST_INLINE_EXTRACTION, now off) nor
 * /api/jobs/tick can finish an extraction in-process — see the
 * INGEST_INLINE_EXTRACTION comment in lib/env.server.ts and
 * docs/performance-remediation-plan.md item 3.5. The queue is drained instead
 * by worker/index.ts running as a GitHub Actions job (no 10s wall). This
 * fires a `repository_dispatch` so that run starts within seconds of an
 * upload instead of on the workflow's sparse cron.
 *
 * Contract:
 *   - Never throws. A dispatch failure is logged + sent to Sentry and
 *     swallowed; the job is already safely in `job_queue`, and the scheduled
 *     workflow run will pick it up regardless.
 *   - A quiet no-op ('skipped') when GITHUB_WORKER_REPO /
 *     GITHUB_WORKER_DISPATCH_TOKEN are unset — local dev, and any deployment
 *     that hasn't done the one-time GitHub setup, behave exactly as before.
 *   - Short timeout: this runs on the request's critical path, and the
 *     dispatch is an optimisation, not a requirement.
 */
export async function triggerRemoteWorker(reason: string): Promise<'sent' | 'skipped' | 'failed'> {
  const repo = serverEnv.GITHUB_WORKER_REPO
  const token = serverEnv.GITHUB_WORKER_DISPATCH_TOKEN
  if (!repo || !token) return 'skipped'

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'istifadah-ilmiyah-worker-trigger',
      },
      body: JSON.stringify({
        event_type: 'run-worker',
        client_payload: { reason: reason.slice(0, 200) },
      }),
      signal: AbortSignal.timeout(5000),
    })

    // 204 No Content is success for this endpoint.
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `GitHub POST /repos/${repo}/dispatches returned ${res.status}: ${body.slice(0, 300)}`
      )
    }
    return 'sent'
  } catch (err) {
    console.error(`[trigger-worker] dispatch failed (${reason}):`, err)
    Sentry.captureException(err, {
      tags: { phase: 'trigger_remote_worker' },
      extra: { reason },
    })
    return 'failed'
  }
}
