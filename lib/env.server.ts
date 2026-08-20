import 'server-only'
import { z } from 'zod'

/**
 * Server secrets (§4.5) — split out of lib/env.ts after a real incident:
 * lib/supabase/client.ts (Client-Component-safe) imported `publicEnv` from
 * the old single env.ts, and importing ANY export from a module runs that
 * module's entire top-level code. Since the old file evaluated
 * `serverEnv = readServerEnv()` unconditionally at the top level, every
 * page that used the browser Supabase client dragged this module's
 * `typeof window` guard into the client bundle too — where it always threw,
 * the moment the bundle actually ran in a browser. Build/SSR never caught
 * it because Node has no `window`.
 *
 * The fix is structural, not just the runtime guard below: this file is
 * never imported by lib/env.ts or anything client-safe, so a Client
 * Component can no longer reach it by accident. `server-only` (Next.js's
 * own sentinel package) turns any future accidental import into a build
 * error instead of a browser-only runtime throw discovered by a user.
 */

const serverSchema = z.object({
  SUPABASE_SECRET_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  SENTRY_AUTH_TOKEN: z.string().optional().default(''),
  DEPLOY_TARGET: z.enum(['vercel', 'server']).default('vercel'),
  CSP_REPORT_ONLY: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v === 'true'),
  WORKER_ID: z.string().min(1).default('local-dev'),
  // Never resolvable on the public internet by design — ITS-number login
  // (lib/auth/its.ts) maps each 8-digit ITS number to
  // `<its_number>@ITS_LOGIN_EMAIL_DOMAIN` and stores that as auth.users.email,
  // Supabase Auth's login handle only. It is never sent anywhere as a real
  // address, so the domain does not need to exist or accept mail.
  ITS_LOGIN_EMAIL_DOMAIN: z.string().min(1).default('members.istifadah.internal'),
  // The organization's own GSTIN, so extraction can tell "the seller's GSTIN"
  // from "our own GSTIN printed as the recipient" -- see buildSystemPrompt in
  // lib/claude-client.ts and the own-org exclusion in
  // lib/jobs/handlers/extract.ts. Optional: when unset, no exclusion runs and
  // vendor_gstin is written exactly as extracted, same as before this field
  // existed.
  COMMUNITY_GSTIN: z.string().optional().default(''),
  // Whether a low-confidence / non-Latin-script Haiku run may automatically
  // re-run on Sonnet (§8 escalation rule, lib/extraction.ts). Default OFF.
  //
  // The rule as written escalates on `contains_non_latin_script`, which is
  // true for most documents in this corpus (Gujarati/Devanagari appear on
  // nearly every vendor bill), so in practice almost every document was
  // running twice -- roughly 4x the intended spend for a second opinion
  // nobody had yet shown was worth it. Haiku runs alone until its output has
  // been reviewed on real documents; set OCR_AUTO_ESCALATION=true to restore
  // the automatic second pass. The manual "Re-extract with Sonnet" button
  // (app/api/documents/reescalate/route.ts) is unaffected either way -- that
  // is a reviewer explicitly asking for Sonnet on one document.
  OCR_AUTO_ESCALATION: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  // Whether the queue-driven initial extraction (handleExtractDocument,
  // lib/jobs/handlers/extract.ts) submits to Anthropic's Batch API instead of
  // calling the synchronous Messages API in-process (plan.md Phase 3 I16).
  // Default OFF, same idiom as OCR_AUTO_ESCALATION above.
  //
  // The Batch API halves per-page cost (estimateCostUsd's `batched` discount,
  // lib/claude-client.ts) but trades latency for it: a batch can take up to
  // 24h to finish processing, vs. seconds synchronously. Flipping this on
  // changes ONLY the queue-driven initial-extraction path -- extractAndPersist
  // itself (used by the manual "Re-extract with Sonnet" button and
  // test/score.ts's accuracy harness) is untouched by this flag and always
  // stays synchronous, so OCR_USE_BATCH_API=false (the default) reproduces
  // today's behavior exactly. See the design-decision comments on
  // submitExtractionBatchAndEnqueuePoll (lib/jobs/handlers/extract.ts) for
  // why the batch path does not chain auto-escalation.
  OCR_USE_BATCH_API: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
  // Whether app/api/documents/ingest/route.ts runs extraction itself, inside
  // the upload request, before responding.
  //
  // Default ON, because with no worker and no cron that inline drain is the
  // ONLY thing that ever moves a job -- turning it off in that situation means
  // nothing extracts, ever.
  //
  // Turn it OFF the moment a real worker is running (worker/index.ts, or a
  // cron hitting /api/jobs/tick). Leaving it on then is actively harmful: the
  // upload route claims its own job the instant it enqueues it, so it beats
  // the worker's 2-second poll essentially every time, and the extraction runs
  // right back inside the request budget the worker exists to escape. The
  // upload then returns in seconds instead of sitting on a 60s platform
  // timeout, and the worker -- which has no timeout at all -- picks the job up
  // on its next poll.
  INGEST_INLINE_EXTRACTION: z
    .string()
    .optional()
    .default('true')
    .transform((v) => v !== 'false'),
})

function readServerEnv() {
  if (typeof window !== 'undefined') {
    throw new Error(
      'serverEnv was imported into browser code. Server secrets (Supabase secret key, Anthropic key, DB URL) must never reach the client bundle — read publicEnv from @/lib/env instead.'
    )
  }
  const parsed = serverSchema.safeParse({
    SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    SENTRY_AUTH_TOKEN: process.env.SENTRY_AUTH_TOKEN,
    DEPLOY_TARGET: process.env.DEPLOY_TARGET,
    CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
    WORKER_ID: process.env.WORKER_ID,
    ITS_LOGIN_EMAIL_DOMAIN: process.env.ITS_LOGIN_EMAIL_DOMAIN,
    COMMUNITY_GSTIN: process.env.COMMUNITY_GSTIN,
    OCR_AUTO_ESCALATION: process.env.OCR_AUTO_ESCALATION,
    OCR_USE_BATCH_API: process.env.OCR_USE_BATCH_API,
    INGEST_INLINE_EXTRACTION: process.env.INGEST_INLINE_EXTRACTION,
  })
  if (!parsed.success) {
    throw new Error(
      `Invalid or missing server environment variables:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}\nCheck .env.local against .env.example.`
    )
  }
  return parsed.data
}

/**
 * Server-only — Route Handlers, Server Components, Server Actions, and
 * worker/index.ts. Throws if evaluated in a browser bundle rather than
 * silently leaking.
 */
export const serverEnv = readServerEnv()

/**
 * True once a real Anthropic key has been provided (MASTER-PLAN §6.4).
 * `.env.example`'s placeholder is a valid-looking string, not a valid key —
 * callers that need OCR (lib/claude-client.ts, worker/handlers/extract.ts)
 * check this and fail with a clear message rather than a cryptic 401
 * partway through a batch.
 */
export const hasAnthropicKey = /^sk-ant-(?!xxx)/.test(serverEnv.ANTHROPIC_API_KEY)
