/**
 * Sentry init for the Edge runtime (MASTER-PLAN §2, §11.1 Day 7 exit
 * criteria). Loaded from instrumentation.ts's `register()` when
 * `NEXT_RUNTIME === 'edge'` — covers middleware and any edge Route
 * Handlers. Same DSN source and empty-DSN guard as instrumentation-client.ts
 * and sentry.server.config.ts; see those files for why `publicEnv` is the
 * one source of truth for the DSN.
 */
import * as Sentry from '@sentry/nextjs'
import { publicEnv } from '@/lib/env'

Sentry.init({
  dsn: publicEnv.NEXT_PUBLIC_SENTRY_DSN || undefined,
  enabled: publicEnv.NEXT_PUBLIC_SENTRY_DSN !== '',
  tracesSampleRate: 0.1,
})
