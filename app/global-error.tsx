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
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          color: '#241F1C',
          background: '#F4EEE4',
        }}
      >
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <div style={{ maxWidth: '360px', textAlign: 'center' }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- next/image depends on the app's own image-optimization pipeline, which this file can't assume survived the crash */}
            <img
              src="/istifadah_logo_1_alpha.png"
              alt="Istifadah Ilmiyah"
              width={96}
              height={96}
              style={{ height: '3.5rem', width: 'auto', margin: '0 auto 1.5rem' }}
            />
            <div
              style={{
                height: '4px',
                width: '48px',
                background: '#7A2438',
                margin: '0 auto 1.5rem',
                borderRadius: '2px',
              }}
            />
            <h1 style={{ margin: 0, fontSize: '1.375rem', fontWeight: 700 }}>Something went wrong</h1>
            <p style={{ margin: '0.75rem 0 1.5rem', fontSize: '0.9rem', color: '#5B534B', lineHeight: 1.5 }}>
              This has been reported automatically. Reloading the page usually clears it.
            </p>
            <button
              onClick={() => reset()}
              style={{
                background: '#7A2438',
                color: '#F7EEE9',
                border: 'none',
                borderRadius: '5px',
                padding: '0.6rem 1.4rem',
                fontSize: '0.9rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reload page
            </button>
            {error.digest && (
              <p
                style={{
                  marginTop: '1rem',
                  fontSize: '0.72rem',
                  color: '#8a8a8a',
                  fontFamily: '"Courier New", monospace',
                }}
              >
                ref: {error.digest}
              </p>
            )}
          </div>
        </div>
      </body>
    </html>
  )
}
