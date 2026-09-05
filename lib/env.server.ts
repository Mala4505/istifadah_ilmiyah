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
  // The organization's canonical name, fuzzy-matched (lib/matching.ts's
  // vendorSimilarity) against the recipient/"Bill To" block on a GST bill --
  // plan §12's recipient-compliance check. Optional: when unset, the buyer-name
  // half of that check cannot run (treated as never matching), same posture
  // as COMMUNITY_GSTIN unset above.
  COMMUNITY_NAME: z.string().optional().default(''),
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
  // Default OFF (changed 2026-09-05, performance-remediation-plan.md 3.5).
  // Was ON by deliberate decision (import-review-ux-plan.md §15, 2026-08-21),
  // made on the assumption that the route's declared `maxDuration = 60` was
  // the real ceiling. It is not: on Vercel Hobby the platform hard-kills a
  // function at 10s regardless of what the route declares, and a measured
  // real bundle already exceeds that (ocr-execution-decision.md's 8-page
  // sample: ~15s wall clock). Leaving this on, on Hobby, means the upload
  // route is silently killed mid-extraction on any bundle past a couple of
  // pages -- this file's own prior comment already said to turn it off "the
  // moment... a cron hitting /api/jobs/tick" is running, and
  // .github/workflows/cron-tick.yml has been running one since before this
  // default was flipped.
  //
  // With this off, the upload route only enqueues the job and returns --
  // extraction happens on the next /api/jobs/tick sweep (GitHub Actions,
  // every 5 minutes) or a running worker (worker/index.ts). The inbox UI
  // already polls /api/documents/status and renders 'uploaded'/'processing'
  // until it flips to 'processed'/'failed' (components/documents/document-inbox.tsx),
  // so this needed no UI change.
  //
  // Turn it back ON only for a deployment plan tier where maxDuration=60 is
  // actually honored (Pro or above, or Fluid compute) AND you want the faster
  // few-second turnaround over the up-to-5-minute cron cadence.
  //
  // IMPORTANT: this schema default only applies where the env var is unset.
  // If INGEST_INLINE_EXTRACTION is explicitly set to "true" in Vercel's
  // project settings (likely, per the 2026-08-21 decision above), this
  // code-level default change has NO EFFECT on the live deployment until
  // that dashboard value is changed to "false" and redeployed.
  INGEST_INLINE_EXTRACTION: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true'),
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
    COMMUNITY_NAME: process.env.COMMUNITY_NAME,
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
