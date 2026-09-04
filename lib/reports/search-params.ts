/**
 * Tiny shared parser for the Reports surfaces' URL drill params
 * (reporting-blueprint.md §6 fix #4: "make every figure a link" — some of
 * those links target a section that keeps its own state in the URL, e.g.
 * `?trace_entry_id=` for E-05 and `?revision_head_id=` for A-02).
 *
 * A route's `searchParams` values are `string | string[] | undefined`; this
 * collapses that to a positive integer or null so the surface loaders take a
 * clean `number | null`.
 */
export function parsePositiveIntParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}
