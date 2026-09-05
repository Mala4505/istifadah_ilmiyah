'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as Sentry from '@sentry/nextjs'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'

/**
 * Reports-segment error boundary (performance-remediation-plan.md §6.2).
 *
 * Every report section already resolves its own query inside a try/catch in
 * its surface loader (lib/reports/surfaces/*.ts) and renders `{error}` via
 * <EmptyState> — see components/reports/sections/purchase-tree.tsx for the
 * pattern. That coverage is intentionally left untouched here.
 *
 * This boundary only catches what falls outside that try/catch — an
 * unexpected throw during rendering (e.g. a chart component crashing on an
 * unexpected shape). Without it, that throw bubbles past this whole route
 * segment to the root app/error.tsx, which blanks the entire page — Explore
 * alone renders 15-20 sections, so a single bad render would otherwise
 * discard every other section's already-successful data.
 *
 * Scoped to app/(app)/reports/** only: it replaces `children` inside
 * app/(app)/reports/layout.tsx, so the sticky period bar and surface-tab nav
 * (both part of the layout, not this segment's page) stay mounted and
 * usable — a reviewer can still switch surfaces or change the period after
 * a crash on one page.
 *
 * Copy/structure mirrors app/error.tsx (Sentry capture, FriendlyError,
 * digest reference, Reload button) but as an inline card rather than a
 * full-screen takeover, since the chrome around it is still live.
 */
export default function ReportsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <Card className="border-destructive/30">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <CardTitle className="text-base">This report couldn&apos;t be displayed</CardTitle>
          {error.message ? (
            <FriendlyError message={error.message} className="max-w-xl" />
          ) : (
            <p className="max-w-xl text-sm text-muted-foreground">
              Something went wrong rendering this page. Try again — if it keeps happening, contact an admin.
            </p>
          )}
          {error.digest && (
            <p className="mt-1 w-fit rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              Case ref: {error.digest}
            </p>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/reports">Back to Explore</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
