/**
 * Batch API `custom_id` encoding/decoding (plan.md Phase 3 I16, §8 point 8).
 *
 * Deliberately its own tiny, dependency-free module rather than living
 * inside lib/claude-client.ts: this logic is pure (no network, no database,
 * no `serverEnv`), but lib/claude-client.ts transitively imports
 * lib/env.server.ts, which imports the `server-only` sentinel package —
 * that package throws on import outside Next.js's `react-server` resolve
 * condition, which includes the vitest unit-test environment (see
 * test/unit/batch-custom-id.test.ts). Keeping this module free of any
 * `server-only`-tainted import is what makes it unit-testable at all.
 *
 * A batch result is matched back to the `source_document` it came from
 * purely by `custom_id` — never by array position (§8 point 8: "results
 * arrive in any order"). Decoding is deliberately strict: anything that
 * doesn't match this exact shape returns null rather than a best-effort
 * guess, so a malformed or foreign custom_id can never be silently
 * misattributed to the wrong document.
 */

const BATCH_CUSTOM_ID_PREFIX = 'extract-document-'

/** Unique within one batch (Anthropic's only requirement); one call per document today, so globally unique in practice. */
export function buildExtractionBatchCustomId(sourceDocumentId: number): string {
  return `${BATCH_CUSTOM_ID_PREFIX}${sourceDocumentId}`
}

/** Returns the source_document id, or null if `customId` doesn't match the exact expected shape. */
export function parseExtractionBatchCustomId(customId: string): number | null {
  if (!customId.startsWith(BATCH_CUSTOM_ID_PREFIX)) return null
  const rest = customId.slice(BATCH_CUSTOM_ID_PREFIX.length)
  if (!/^[1-9]\d*$/.test(rest)) return null
  const id = Number(rest)
  return Number.isSafeInteger(id) ? id : null
}
