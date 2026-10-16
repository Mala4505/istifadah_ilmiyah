/**
 * Safe building blocks for PostgREST `.or(...)` filter strings.
 *
 * Why this exists: `.or()` takes ONE string in PostgREST's filter grammar, in
 * which `,` `.` `(` `)` are delimiters. Interpolating a user-typed search term
 * straight into it lets the caller close the current condition and append their
 * own (e.g. `x,id.gt.0`), widening what the query returns. Double-quoting the
 * value makes every delimiter literal; inside the quotes only `\` and `"` still
 * need escaping (PostgREST's documented quoted-value syntax).
 *
 * Plain module on purpose (no 'use client' / 'use server' / server-only): it is
 * imported as a VALUE by server actions, and importing a value from a
 * 'use client' module into a Server Component/action crashes the production
 * RSC build.
 */

/** Wraps `raw` in double quotes, escaping `\` and `"` so no character in it can end the value. */
export function quotePostgrestValue(raw: string): string {
  return `"${raw.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Escapes the LIKE wildcards (`%`, `_`) and the LIKE escape character (`\`) in
 * a user-typed term so it matches literally. Apply BEFORE `quotePostgrestValue`,
 * which then doubles the backslashes for the filter grammar; PostgREST un-doubles
 * them before Postgres sees the pattern.
 */
export function escapeLikeLiteral(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

/** Upper bound on a typed search term; no legitimate search needs more. */
export const MAX_SEARCH_TERM_LENGTH = 200

/**
 * `"%term%"` as a quoted PostgREST value, matching the term literally (user
 * `%`/`_` are not wildcards) and safe against filter-grammar injection.
 */
export function quotedContainsPattern(term: string, transform?: (s: string) => string): string {
  const bounded = term.trim().slice(0, MAX_SEARCH_TERM_LENGTH)
  const text = transform ? transform(bounded) : bounded
  return quotePostgrestValue(`%${escapeLikeLiteral(text)}%`)
}

/**
 * Builds the argument for `.or(...)`: one case-insensitive "contains" condition
 * per column, joined with commas. Every value is quoted.
 *
 * Example: `buildIlikeOrFilter(['a', 'b'], 'x,id.gt.0')` returns
 * `a.ilike."%x,id.gt.0%",b.ilike."%x,id.gt.0%"` -- the comma and dots are inside
 * the quotes, so they are data, not syntax.
 */
export function buildIlikeOrFilter(columns: readonly string[], term: string): string {
  const pattern = quotedContainsPattern(term)
  return columns.map((column) => `${column}.ilike.${pattern}`).join(',')
}
