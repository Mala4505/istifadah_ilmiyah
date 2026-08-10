/**
 * Sentry init for the browser (MASTER-PLAN §2, §11.1 Day 7 exit criteria).
 *
 * `instrumentation-client.ts` is a Next.js App Router convention (loaded
 * automatically before hydration) that the current @sentry/nextjs SDK
 * recommends over the older `sentry.client.config.ts` — the latter is
 * deprecated and stops working under Turbopack. Reads the DSN through
 * `publicEnv` (lib/env.ts) rather than `process.env` directly —
 * that's the one place in the app the public env schema is validated, and
 * the DSN is public by design (§4.4b: it only accepts writes, so it's safe
 * in a client bundle).
 *
 * `NEXT_PUBLIC_SENTRY_DSN` defaults to `''` in lib/env.ts, which this repo
 * runs on locally without a real Sentry project. `enabled` guards that case
 * so Sentry no-ops cleanly instead of warning on every page load.
 */
import * as Sentry from '@sentry/nextjs'
import { publicEnv } from '@/lib/env'

Sentry.init({
  dsn: publicEnv.NEXT_PUBLIC_SENTRY_DSN || undefined,
  enabled: publicEnv.NEXT_PUBLIC_SENTRY_DSN !== '',
  tracesSampleRate: 0.1,
})

// Required by the SDK to instrument client-side route transitions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
