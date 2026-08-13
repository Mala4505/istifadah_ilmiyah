/**
 * Turns a raw Postgres/JS error string into something a non-technical
 * operator can act on. Several places in the app used to render
 * `error.message` straight from Postgres or a thrown Error — a duplicate-key
 * constraint name or a stack-trace fragment tells an operator nothing they
 * can do anything with. This is a best-effort classifier, not a parser: it
 * pattern-matches the handful of shapes that show up in practice and falls
 * back to a generic message rather than guessing. The original string is
 * never discarded — callers show it as a secondary "technical detail" a
 * support conversation can still use.
 */
export function friendlyErrorMessage(raw: string | null | undefined): string {
  if (!raw) return 'Something went wrong.'
  const message = raw.trim()
  if (message.length === 0) return 'Something went wrong.'

  const rules: Array<{ pattern: RegExp; friendly: string }> = [
    {
      pattern: /duplicate key value violates unique constraint/i,
      friendly: 'This already exists — it looks like a duplicate.',
    },
    {
      pattern: /violates foreign key constraint/i,
      friendly: 'This refers to something that doesn’t exist (yet). Try again after the related record is created.',
    },
    {
      pattern: /violates not-null constraint/i,
      friendly: 'A required field was left empty.',
    },
    {
      pattern: /violates check constraint/i,
      friendly: 'One of the values isn’t allowed here.',
    },
    {
      pattern: /permission denied|not authorized|not authenticated|row-level security/i,
      friendly: 'You don’t have permission to do this.',
    },
    {
      pattern: /network error|failed to fetch|ECONNREFUSED|fetch failed/i,
      friendly: 'Couldn’t reach the server. Check your connection and try again.',
    },
    {
      pattern: /timeout|timed out/i,
      friendly: 'That took too long and timed out. Try again.',
    },
    {
      pattern: /^(\w[\w ]*?)\s+insert failed:|^(\w[\w ]*?)\s+update failed:/i,
      friendly: 'Something went wrong while saving. Try again, or contact an admin if it keeps happening.',
    },
  ]

  for (const rule of rules) {
    if (rule.pattern.test(message)) return rule.friendly
  }

  // Anything left that still looks like raw plumbing (SQL/identifier noise,
  // stack-trace markers, an internal doc citation) gets a generic fallback
  // instead of being shown verbatim. A short, plain sentence with no such
  // markers is assumed to already be human-written and passed through as-is.
  const looksTechnical =
    /(_id\b|_jsonb\b|\bsql\b|\bat \S+:\d+:\d+|relation "|column "|MASTER-PLAN §|\berror:\s*error:)/i.test(
      message
    ) || message.length > 160

  if (looksTechnical) {
    return 'Something went wrong. See the technical detail below, or contact an admin if it keeps happening.'
  }

  return message
}
