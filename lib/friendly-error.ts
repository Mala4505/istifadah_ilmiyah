/**
 * One place that turns whatever a failure actually threw — a Postgres
 * constraint violation, a PostgREST envelope, a Supabase Auth error, an
 * Anthropic API error body, a fetch rejection — into a sentence an operator
 * can read and act on.
 *
 * The rule this module exists to enforce: **the screen never shows raw
 * plumbing.** No JSON blobs, no constraint names, no stack frames, no
 * `{"type":"error",...}`. The raw text is not thrown away — it goes to the
 * server/browser log via `logRawError` so an admin or Sentry can still get at
 * it — but what the user reads is plain English plus, where it's known, the
 * next thing to try.
 *
 * Two entry points:
 *   - `friendlyErrorMessage(raw)`  — pure, string in / string out.
 *   - `friendlyDataError(error, context)` — for Supabase `{ data, error }`
 *     results: logs the raw message under `context`, returns the friendly one
 *     (or null when there was no error), so a page can pass the result
 *     straight into a component's `description`/`error` prop.
 */

/**
 * Records the raw failure text where a developer can still find it, keyed by
 * a short call-site label. Server components / actions land in the Node log
 * (and Sentry, which instruments console.error); client components land in
 * the browser console. Deliberately `console.error` rather than a direct
 * Sentry call so this module stays importable from both runtimes without a
 * conditional import.
 */
export function logRawError<T>(context: string, raw: T): T {
  if (raw !== null && raw !== undefined) console.error(`[${context}]`, raw)
  // Returns its input so a call site can log in passing without restructuring
  // — `return { ok: false, error: logRawError('ctx', error.message) }`.
  return raw
}

/**
 * Pulls a human-ish sentence out of a raw string that is really a serialized
 * object — the single most common way an unreadable error reaches the screen.
 * Anthropic's Batch API error bodies, PostgREST envelopes and anything that
 * went through `JSON.stringify` all arrive looking like
 * `{"type":"error","error":{"type":"rate_limit_error","message":"..."}}`.
 * Returns the innermost `message`/`error`/`detail` string it can find, or
 * null when the blob has nothing readable in it.
 */
function unwrapSerialized(message: string): string | null {
  const looksSerialized = /^[[{]/.test(message)
  if (!looksSerialized) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(message)
  } catch {
    return null
  }

  // Walk a bounded number of levels looking for a message-shaped string.
  // Bounded, not recursive-unbounded, so a pathological payload can't spin.
  const KEYS = ['message', 'error_description', 'detail', 'details', 'error', 'msg']
  let node: unknown = parsed
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof node === 'string') return node.trim() || null
    if (Array.isArray(node)) {
      node = node[0]
      continue
    }
    if (!node || typeof node !== 'object') return null
    const record = node as Record<string, unknown>
    const nextKey = KEYS.find((key) => key in record && record[key] !== null && record[key] !== '')
    if (!nextKey) return null
    node = record[nextKey]
  }
  return null
}

/**
 * Ordered most-specific-first: the first pattern that matches wins, so a
 * message that mentions both a constraint and a permission is described by
 * whichever cause an operator can actually do something about.
 */
const RULES: Array<{ pattern: RegExp; friendly: string }> = [
  // ---- permission / session -------------------------------------------------
  {
    pattern: /jwt expired|token is expired|session (has )?expired|refresh token|auth session missing/i,
    friendly: 'Your session has expired. Sign in again and retry.',
  },
  {
    pattern: /invalid login credentials|invalid credentials/i,
    friendly: 'That ITS number and password don’t match. Check both and try again.',
  },
  {
    pattern: /permission denied|not authori[sz]ed|unauthorized|not authenticated|row-level security|insufficient privilege|forbidden|\b403\b/i,
    friendly:
      'You don’t have permission to do this — it may belong to another department, or need a reviewer or admin account.',
  },

  // ---- data integrity -------------------------------------------------------
  {
    pattern: /duplicate key value violates unique constraint|already exists|unique_violation|\b23505\b/i,
    friendly: 'This already exists — it looks like a duplicate.',
  },
  {
    pattern: /violates foreign key constraint|\b23503\b/i,
    friendly:
      'This refers to something that doesn’t exist yet. Try again once the related record has been created.',
  },
  {
    pattern: /violates not-null constraint|null value in column|\b23502\b/i,
    friendly: 'A required field was left empty.',
  },
  {
    pattern: /violates check constraint|\b23514\b/i,
    friendly: 'One of the values isn’t allowed here. Pick one of the listed options and try again.',
  },
  {
    pattern: /invalid input syntax for type|invalid input value for enum|\b22P02\b/i,
    friendly: 'One of the values is in the wrong format — check dates, numbers and amounts.',
  },
  {
    pattern: /value too long for type|\b22001\b/i,
    friendly: 'One of the values is too long. Shorten it and try again.',
  },
  {
    pattern: /numeric field overflow|out of range/i,
    friendly: 'One of the amounts is too large for this field.',
  },

  // ---- not found / empty result --------------------------------------------
  {
    pattern: /PGRST116|multiple \(or no\) rows returned|no rows returned|\b404\b|not found/i,
    friendly: 'That record couldn’t be found. It may have been changed or removed — refresh and try again.',
  },
  {
    pattern: /schema cache|PGRST20\d|could not find the (function|table|column)/i,
    friendly: 'The app and the database are briefly out of step. Wait a moment and try again, or contact an admin.',
  },

  // ---- capacity / transport -------------------------------------------------
  {
    pattern: /payload too large|request entity too large|maximum allowed size|file size limit|\b413\b/i,
    friendly: 'That file is too large to upload. Split it into smaller PDFs and try again.',
  },
  {
    pattern: /rate.?limit|too many requests|overloaded|\b429\b|\b529\b/i,
    friendly: 'The service is busy right now. Wait a minute and try again.',
  },
  {
    pattern: /statement timeout|canceling statement|timeout|timed out|ETIMEDOUT/i,
    friendly: 'That took too long and stopped. Try again — narrowing the date range or filters usually helps.',
  },
  {
    pattern: /network error|failed to fetch|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|socket hang up|load failed/i,
    friendly: 'Couldn’t reach the server. Check your connection and try again.',
  },
  {
    pattern: /\b5\d\d\b|internal server error|bad gateway|service unavailable/i,
    friendly: 'The server had a problem handling that. Try again — if it keeps happening, contact an admin.',
  },
  {
    pattern: /aborted|abort(ed)? by (the )?user|canceled|cancelled/i,
    friendly: 'That was canceled.',
  },

  // ---- storage --------------------------------------------------------------
  {
    pattern: /bucket not found|object not found|no such (file|key)/i,
    friendly: 'The file couldn’t be found in storage. It may still be uploading — refresh, or re-upload it.',
  },

  // ---- generic write failures we wrap ourselves ------------------------------
  {
    pattern: /(insert|update|upsert|delete) failed:/i,
    friendly: 'Something went wrong while saving. Try again, or contact an admin if it keeps happening.',
  },
]

/**
 * True when a string still reads as plumbing rather than prose — JSON/SQL
 * punctuation, identifier noise, stack frames, an internal doc citation, or
 * simply far too long to be a sentence someone wrote for a user.
 */
function looksTechnical(message: string): boolean {
  return (
    /[{}]|^\s*\[|_id\b|_jsonb\b|\bsql\b|\bat \S+:\d+:\d+|relation "|column "|constraint "|function \w+\(|MASTER-PLAN §|\berror:\s*error:|\bPGRST\d+\b|\b[A-Z]{2}\d{3}\b/.test(
      message
    ) || message.length > 160
  )
}

/**
 * Turns a raw failure string into something a non-technical operator can act
 * on. Best-effort classifier, not a parser: it recognises the shapes that
 * actually show up in this app and falls back to a generic sentence rather
 * than guessing. A short, plain, already-human sentence passes through
 * unchanged — most of this app's own validation messages are exactly that.
 */
export function friendlyErrorMessage(raw: string | null | undefined): string {
  const GENERIC = 'Something went wrong. Try again — if it keeps happening, contact an admin.'
  if (!raw) return GENERIC

  let message = raw.trim()
  if (message.length === 0) return GENERIC

  // A serialized blob is classified on the sentence hiding inside it, not on
  // the braces around it — a rate-limit body should still say "the service is
  // busy", not fall through to the generic sentence.
  const unwrapped = unwrapSerialized(message)
  if (unwrapped) message = unwrapped

  for (const rule of RULES) {
    if (rule.pattern.test(message)) return rule.friendly
  }

  return looksTechnical(message) ? GENERIC : message
}

/**
 * Wrapper for the Supabase `{ data, error }` shape used all over the RSC
 * pages: logs the raw message under `context` and returns the friendly one,
 * or null when nothing failed. Lets a page keep its `error?.message ?? null`
 * one-liner while guaranteeing the string it hands to a component is prose.
 */
export function friendlyDataError(
  error: { message: string } | null | undefined,
  context: string
): string | null {
  if (!error) return null
  logRawError(context, error.message)
  return friendlyErrorMessage(error.message)
}

/**
 * Maps a raw OCR-pipeline failure (`ocr_extraction_run.error_message`,
 * written by recordExtractionFailure in lib/jobs/handlers/extract.ts) to the
 * next step a reviewer can actually take. The raw message is NOT shown next
 * to this any more — it is a model/provider payload that regularly arrives as
 * a JSON blob — so this string has to carry the whole explanation on its own.
 * The raw text stays available behind the card's "Technical detail" toggle.
 */
export function extractionFailureGuidance(raw: string | null | undefined): string {
  const fallback = 'Re-run extraction. If it keeps failing, park this document or flag it for a closer look.'
  if (!raw) return fallback
  const message = (unwrapSerialized(raw.trim()) ?? raw).toLowerCase()

  if (/max_tokens|truncat/.test(message)) {
    return 'The document had more content than the reader could return in one pass. Re-run extraction — if it fails again, this document needs to be split into fewer pages.'
  }
  if (/downloading .* failed|http \d{3}|bucket not found|object not found/.test(message)) {
    return 'The file could not be downloaded from storage. Re-run extraction — if it keeps failing, re-upload the file.'
  }
  if (/rate.?limit|overloaded|too many requests|429|529/.test(message)) {
    return 'The reading service was busy and turned this request away. Wait a minute, then re-run extraction.'
  }
  if (/image|too large|dimension|payload/.test(message)) {
    return 'The pages were too large for the reader to accept. Re-upload the file at a smaller size, or split it into fewer pages.'
  }
  if (/batch|errored|canceled|cancelled|expired/.test(message)) {
    return 'The reading job was interrupted before it finished. Re-run extraction to submit it again.'
  }
  if (/permission denied|not authorized|row-level security|api key|authentication/.test(message)) {
    return 'A permissions problem stopped extraction. Contact an admin — this is not something a re-run will fix.'
  }
  return fallback
}
