'use client'

import { useEffect, useRef, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Download, FileSpreadsheet, FileText, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import {
  getBoardPackDownloadUrl,
  enqueueBoardPack,
  getBoardPackJobStatus,
} from '@/app/(app)/reports/board-pack-actions'

// Client controls for the board-pack list. Kept free of any value import from a
// server module -- they take plain props and call the server actions directly.

export function BoardPackDownloadButton({
  boardPackId,
  kind,
}: {
  boardPackId: number
  kind: 'xlsx' | 'pdf'
}) {
  const [isPending, startTransition] = useTransition()
  const Icon = kind === 'xlsx' ? FileSpreadsheet : FileText

  function handleClick() {
    startTransition(async () => {
      const result = await getBoardPackDownloadUrl(boardPackId, kind)
      if (!result.ok) {
        toastError(result.error, { context: 'board-pack-download' })
        return
      }
      if ('url' in result) window.open(result.url, '_blank', 'noopener,noreferrer')
    })
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {kind === 'xlsx' ? 'Workbook' : 'PDF'}
    </Button>
  )
}

/**
 * Perf remediation Phase 7.9: once "Generate now" enqueues a job, the board
 * pack itself only shows up in BoardPackList (a Server Component) after some
 * later drain tick runs it -- previously the toast just said so and left the
 * user to notice by reloading. This polls the single job_queue row and
 * router.refresh()'s the page the moment it finishes, mirroring the narrow
 * status-poll shape in components/documents/document-inbox.tsx (poll a
 * cheap lookup, back off on each empty tick, never refresh on a dumb timer).
 *
 * A revalidateTag/revalidatePath fired from the job's own completion was
 * considered instead, but the handler (lib/jobs/handlers/board-pack.ts) is
 * dispatched from worker/index.ts's standalone drain loop as often as from a
 * Next.js request (app/api/jobs/tick/route.ts) -- outside a request there is
 * no Next cache context for revalidatePath to act on. Polling from the
 * client, which is always inside one, sidesteps that.
 *
 * The interval backs off from 3s to a 15s cap and gives up after
 * POLL_MAX_ATTEMPTS (~3.5 minutes of polling): a live worker loop drains the
 * queue in well under that, and this queue has no tighter SLA than "the next
 * tick" -- Vercel Cron is a once-a-day safety net on Hobby, so a run can
 * legitimately take far longer than any bounded poll. Giving up silently
 * past the cap is deliberate: the original toast already told the user this
 * may need a later manual look.
 */
const POLL_INTERVALS_MS = [3000, 5000, 8000, 15000] as const
const POLL_MAX_ATTEMPTS = 16

export function BoardPackGenerateButton() {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  // Guards the poll chain against acting after unmount (e.g. the user
  // navigates away from /reports/brief while a job is still queued).
  const mountedRef = useRef(true)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current)
    }
  }, [])

  function scheduleStatusCheck(jobId: number, attempt: number) {
    if (!mountedRef.current) return
    const delay = POLL_INTERVALS_MS[Math.min(attempt, POLL_INTERVALS_MS.length - 1)]
    pollTimeoutRef.current = setTimeout(() => void checkJobStatus(jobId, attempt), delay)
  }

  async function checkJobStatus(jobId: number, attempt: number) {
    if (!mountedRef.current) return
    const result = await getBoardPackJobStatus(jobId)
    if (!mountedRef.current) return

    if (result.ok && result.status === 'succeeded') {
      toast.success('Board pack ready.')
      router.refresh()
      return
    }
    if (result.ok && (result.status === 'failed' || result.status === 'dead')) {
      toastError('The board pack failed to generate. Try again, or contact an admin if it keeps happening.', {
        context: 'board-pack-generate',
      })
      return
    }
    // Still queued/running, or this status lookup itself hiccuped -- either
    // way, keep trying up to the cap described above.
    if (attempt + 1 >= POLL_MAX_ATTEMPTS) return
    scheduleStatusCheck(jobId, attempt + 1)
  }

  function handleClick() {
    startTransition(async () => {
      const result = await enqueueBoardPack()
      if (!result.ok) {
        toastError(result.error, { context: 'board-pack-download' })
        return
      }
      toast.success('Board pack queued — it will appear here once the next job tick runs.')
      if ('jobId' in result) scheduleStatusCheck(result.jobId, 0)
    })
  }

  return (
    <Button variant="outline" size="sm" onClick={handleClick} disabled={isPending}>
      {isPending ? (
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Generate now
    </Button>
  )
}
