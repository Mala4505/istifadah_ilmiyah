import { CATEGORICAL_PALETTE, OTHER_STEP } from '@/components/reports/charts/categorical-palette'
import { formatNumber } from '@/lib/reports/format'
import type { DonutSegment } from '@/components/reports/charts/lazy'

// Plain (non-'use client') helper so Server Component sections can build
// DonutChart segments locally and pass only plain data across the boundary.
//
// Part-to-whole donuts carry at most MAX_SLICES slices (the dataviz skill's
// 5-6 categorical soft cap): when there are more items than that, the top
// (MAX_SLICES - 1) keep a hue and the tail folds into one neutral "Other"
// slice — never a 7th generated hue, never a repeated one (the old
// `ORDINAL_RAMP[i % 4]` bug, where slices 5-6 reused slices 1-2's colour).
export const MAX_SLICES = 6

export type ShareItem = { key: string; label: string; value: number }

/**
 * `items` must already be sorted largest-first. Hues follow that order —
 * stable for a given event's data, since nothing on the page filters the
 * series away and repaints the survivors.
 */
export function shareSegments(
  items: readonly ShareItem[],
  { otherNoun = 'items', maxSlices = MAX_SLICES }: { otherNoun?: string; maxSlices?: number } = {}
): DonutSegment[] {
  const positive = items.filter((i) => i.value > 0)
  const cap = Math.min(maxSlices, CATEGORICAL_PALETTE.length)
  const keep = positive.length <= cap ? positive : positive.slice(0, cap - 1)
  const rest = positive.slice(keep.length)
  const segments: DonutSegment[] = keep.map((item, i) => ({
    key: item.key,
    label: item.label,
    value: item.value,
    colorClass: CATEGORICAL_PALETTE[i]!.strokeClass,
    hex: CATEGORICAL_PALETTE[i]!.hex,
  }))
  if (rest.length > 0) {
    segments.push({
      key: '__other__',
      label: `Other (${formatNumber(rest.length)} ${otherNoun})`,
      value: rest.reduce((sum, r) => sum + r.value, 0),
      colorClass: OTHER_STEP.strokeClass,
      hex: OTHER_STEP.hex,
    })
  }
  return segments
}
