/**
 * Client-safe pieces of the compare-basis machinery -- split out of
 * lib/reports/compare-basis.ts so modules that only need the type/labels
 * (e.g. lib/reports/sections/shared.tsx, which is imported by client
 * components) don't drag in that file's top-level `next/headers` import.
 * See lib/reports/compare-basis.ts for `getCompareBasis()`, the only piece
 * that actually needs server-only cookies().
 */
export const COMPARE_BASIS_COOKIE = 'report_compare_basis'

export type CompareBasis = 'prior_week' | 'prior_event' | 'none'

const VALID_BASES: readonly CompareBasis[] = ['prior_week', 'prior_event', 'none']

export function isCompareBasis(value: string | undefined): value is CompareBasis {
  return VALID_BASES.includes(value as CompareBasis)
}

export const COMPARE_BASIS_LABELS: Record<CompareBasis, string> = {
  prior_week: 'vs last week',
  prior_event: 'vs prior event',
  none: 'No comparison',
}
