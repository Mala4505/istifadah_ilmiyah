'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import * as Sentry from '@sentry/nextjs'
import { Button } from '@/components/ui/button'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Logo } from '@/components/app-shell/logo'

// Root-level route error boundary — catches anything thrown while a page or
// layout renders, but only once the app shell itself mounted successfully
// (a crash before that falls through to app/global-error.tsx instead).
export default function Error({
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
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background px-4 py-16 text-center">
      <Logo imageClassName="w-24" />
      <div className="flex flex-col items-center gap-3">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-secondary">
          Ref · flagged for review
        </p>
        <h1 className="max-w-md font-display text-2xl font-semibold [text-wrap:balance]">
          Something went wrong loading this page
        </h1>
        {error.message ? (
          <FriendlyError message={error.message} className="max-w-sm" />
        ) : (
          <p className="max-w-sm text-sm text-muted-foreground">
            Something went wrong. Try again — if it keeps happening, contact an admin.
          </p>
        )}
        {error.digest && (
          <p className="rounded border border-border bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
            Case ref: {error.digest}
          </p>
        )}
      </div>
      <div className="flex gap-3">
        <Button onClick={reset}>Reload</Button>
        <Button asChild variant="outline">
          <Link href="/">Back to Hub</Link>
        </Button>
      </div>
    </main>
  )
}
