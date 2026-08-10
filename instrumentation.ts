/**
 * Next.js instrumentation hook (MASTER-PLAN §2, §11.1 Day 7 exit criteria:
 * "Sentry + uptime check live"). Next.js calls `register()` once per
 * runtime at boot; this just loads the matching Sentry init file so
 * Route Handlers, Server Components, Server Actions, and Vercel Cron
 * invocations (app/api/jobs/tick/route.ts) are covered on the Node
 * runtime, and middleware is covered on the Edge runtime.
 *
 * The client runtime doesn't go through here — instrumentation-client.ts is
 * a separate Next.js convention, loaded automatically before hydration.
 */
import { captureRequestError } from '@sentry/nextjs'

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config')
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config')
  }
}

export const onRequestError = captureRequestError
