/**
 * Broken-axis scaling for ₹ bar charts where one or two rows dwarf the rest
 * (e.g. Venue Setup's budget against every other department) — with a linear
 * 0→max scale everyone else's bar shrinks to a sliver and their budget can't
 * be read.
 *
 * Rule: sort values descending; if the top k values (k = 1 or 2) are each more
 * than `ratio`× the next value, cap the scale `headroom` above that next value,
 * rounded up to a clean figure. Bars past the cap are drawn to the edge with a
 * visible break mark by the chart, and their true figures stay written on the
 * row — the cap changes geometry only, never a number. Fewer than 3 positive
 * values, or no such gap → no cap (null).
 *
 * Plain module (no React / Supabase) so it is unit-testable and usable from
 * both server and client components.
 */
export type OutlierScale = {
  /** Axis maximum to use, or null to keep the full linear scale. */
  cap: number | null
  /** How many rows run past the cap. */
  outlierCount: number
}

const MAX_OUTLIERS = 2

export function niceCeil(v: number): number {
  if (!(v > 0)) return 0
  const exp = Math.floor(Math.log10(v))
  const base = 10 ** exp
  const f = v / base
  // Finer than the usual 1/2/5 ladder: a coarse step can nearly double the
  // cap (5.04 → 10) and waste half the axis we're trying to reclaim.
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => f <= s + 1e-9) ?? 10
  return step * base
}

export function outlierScale(values: number[], { ratio = 2, headroom = 1.2 } = {}): OutlierScale {
  const sorted = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => b - a)
  if (sorted.length < 3) return { cap: null, outlierCount: 0 }
  for (let k = 1; k <= Math.min(MAX_OUTLIERS, sorted.length - 2); k++) {
    const lastOutlier = sorted[k - 1]!
    const next = sorted[k]!
    if (lastOutlier > ratio * next) {
      const cap = niceCeil(next * headroom)
      if (cap < sorted[0]!) {
        return { cap, outlierCount: sorted.filter((v) => v > cap).length }
      }
    }
  }
  return { cap: null, outlierCount: 0 }
}
