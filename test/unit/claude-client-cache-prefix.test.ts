import { describe, expect, it, vi } from 'vitest'

// lib/claude-client.ts pulls in lib/env.server.ts, which imports the
// `server-only` sentinel package — it throws whenever the "react-server"
// module-resolution condition isn't active, which is never the case under
// plain `vitest run` (only Next.js's own server build sets it). Stubbing it
// out here is a test-only concern, scoped to this file alone.
vi.mock('server-only', () => ({}))

// lib/env.server.ts also reads its required vars eagerly at module load
// (readServerEnv() runs at the top level, not lazily) — these three are only
// validated for non-emptiness by Zod and never actually used by anything
// this test calls (buildCachedSystemPrompt/buildExtractionTool are pure
// string/object builders — nothing here constructs a real Anthropic
// client), so filler values are fine. `??=` leaves real values from an
// actual .env untouched if this ever runs somewhere they're already set.
process.env.SUPABASE_SECRET_KEY ??= 'test-filler-value'
process.env.ANTHROPIC_API_KEY ??= 'test-filler-value'
process.env.DATABASE_URL ??= 'test-filler-value'

const { buildCachedSystemPrompt } = await import('@/lib/claude-client')
const { buildExtractionTool } = await import('@/lib/extraction-schema')

/**
 * Regression guard for the prompt-cache cliff documented in
 * lib/claude-client.ts (see the comment block above `buildSystemPrompt`,
 * roughly lines 218-231): Anthropic only caches the system-prompt+tool-schema
 * prefix when it is at least 4,096 tokens for claude-haiku-4-5 (1,024 for
 * claude-sonnet-5), and falling short of that floor is SILENT — no error, no
 * warning, just a cache write that quietly never happens and an input cost
 * that quietly goes up every call thereafter.
 *
 * There is no token-counting library in this repo (no tiktoken/gpt-tokenizer/
 * Anthropic tokenizer in package.json), and Claude's real tokenizer isn't
 * published as an npm package anyway — an approximate library wouldn't even
 * be exact, so this test uses a character-count proxy instead of a real
 * token count. It is an approximation, not an exact token count, and is not a
 * substitute for confirming the real number via
 * `ocr_extraction_run.raw_response_jsonb -> usage -> cache_creation_input_tokens`
 * on an actual production call.
 *
 * Anthropic's docs give a rough ballpark of ~4 characters per token for
 * plain English prose, but that ballpark does not hold for THIS prefix: it's
 * a dense JSON tool schema plus terse instruction text (lots of punctuation,
 * short property names, enum lists), and this codebase already has a real
 * measured data point proving it tokenizes much denser than prose. Before
 * the worked-examples fix (the same lib/claude-client.ts comment above),
 * the tool schema + base system prompt — 10,422 characters, by construction
 * identical to `buildCachedPrefix()` below minus the worked-examples
 * paragraph — produced a real, measured 4,039 tokens on a successful
 * claude-sonnet-5 cache write (`cache_creation_input_tokens`), i.e. ~2.58
 * characters per token, not ~4. Using the generic ~4 ballpark here would
 * produce a floor (16,384 characters for a 4,096-token target) that the
 * actual, already-safely-caching prefix does not even reach — a floor that
 * fails content already proven fine is worse than useless, since the first
 * time it fails no one could tell a real regression from a false alarm.
 *
 * So this test calibrates off that real measurement instead of the generic
 * ballpark, rounding the observed ~2.58 chars/token UP to 2.6 (i.e.
 * deliberately assuming it takes slightly MORE characters to earn each token
 * than production actually showed — the conservative direction, since a
 * larger chars-per-token divisor yields a stricter, more pessimistic
 * required-character floor for the same token target) and additionally
 * requiring the estimated token count to clear the real 4,096 cliff by 5%,
 * not just meet it exactly. Both adjustments push the floor up from the bare
 * measured anchor, so a real shrink has to eat into genuine margin — not
 * just noise from one edit — before this test fails, while it still fails
 * comfortably before the real, silent token cliff.
 */
const HAIKU_CACHE_FLOOR_TOKENS = 4096
const SAFETY_MARGIN_MULTIPLIER = 1.05
const CONSERVATIVE_CHARS_PER_TOKEN = 2.6
const MINIMUM_CACHED_PREFIX_CHARS = Math.ceil(
  HAIKU_CACHE_FLOOR_TOKENS * SAFETY_MARGIN_MULTIPLIER * CONSERVATIVE_CHARS_PER_TOKEN
)

/**
 * Reconstructs the exact cached prefix Anthropic sees: render order is
 * tools -> system -> messages (see buildCachedSystemPrompt's own doc
 * comment in lib/claude-client.ts), and the single cache_control breakpoint
 * sits on the last (only) system block, so everything before and including
 * that block — the tool schema's JSON.stringify'd wire shape plus the system
 * prompt text — is what actually gets cached together.
 *
 * communityGstin/communityName are both null: the shortest realistic variant
 * of buildSystemPrompt's output (see its doc comment — both extra blocks are
 * appended only when one of these is set), and therefore the worst case for
 * this floor.
 */
function buildCachedPrefix(): string {
  const toolSchemaJson = JSON.stringify(buildExtractionTool())
  const [systemBlock] = buildCachedSystemPrompt(null, null)
  return toolSchemaJson + (systemBlock?.text ?? '')
}

describe('claude-client prompt-cache prefix — token-cliff regression guard', () => {
  it('stays comfortably above the character-count floor backing the 4,096-token cache-eligibility cliff', () => {
    const prefix = buildCachedPrefix()
    expect(prefix.length).toBeGreaterThanOrEqual(MINIMUM_CACHED_PREFIX_CHARS)
  })
})
