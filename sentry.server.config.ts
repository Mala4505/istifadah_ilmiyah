/**
 * Sentry init for the Node.js server runtime (MASTER-PLAN §2, §11.1 Day 7
 * exit criteria). Loaded from instrumentation.ts's `register()` when
 * `NEXT_RUNTIME === 'nodejs'` — covers Route Handlers, Server Components,
 * Server Actions, and (indirectly, since it shares the same env schema)
 * worker/index.ts's own explicit Sentry.init in worker/index.ts.
 *
 * Reads the DSN through `publicEnv` (lib/env.ts), same as
 * instrumentation-client.ts — the DSN is public by design (§4.4b), so there's no need to read
 * it through the server-secrets schema in lib/env.server.ts. `enabled`
 * guards the default empty-DSN case this repo runs with locally.
 */
import * as Sentry from '@sentry/nextjs'
import { publicEnv } from '@/lib/env'

Sentry.init({
  dsn: publicEnv.NEXT_PUBLIC_SENTRY_DSN || undefined,
  enabled: publicEnv.NEXT_PUBLIC_SENTRY_DSN !== '',
  tracesSampleRate: 0.1,
})
