'use client'

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'

/**
 * Root error boundary for uncaught render errors (Next.js App Router
 * convention — MASTER-PLAN §2, §11.1 Day 7: "Sentry + uptime check live").
 * Next.js only mounts this when an error escapes every nested error.tsx,
 * so it replaces the entire root layout — hence the standalone <html>/<body>
 * here rather than relying on app/layout.tsx. Deliberately minimal (no
 * fonts, no Toaster, no project components): if the root layout itself is
 * what broke, this file can't lean on anything that might also be broken.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string }
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body>
        <div style={{ padding: '3rem', fontFamily: 'sans-serif', textAlign: 'center' }}>
          <h1>Something went wrong</h1>
          <p>The error has been reported. Please try reloading the page.</p>
        </div>
      </body>
    </html>
  )
}
