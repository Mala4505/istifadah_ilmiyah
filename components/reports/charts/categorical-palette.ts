// Categorical palette for charts whose colour encodes IDENTITY (budget
// categories, reimbursement types, zones, vendor×item series) — unlike
// ordinal-ramp.ts, which is one hue in monotone steps for ordered stages and
// must never be used for unordered categories (neighbouring blues blur).
//
// Slots 1-6 of the dataviz skill's reference palette (references/palette.md),
// assigned in this fixed order, never cycled: a 7th+ category folds into
// "Other" (OTHER_STEP). Validated with the skill's validator:
//   light  #2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300 -> ALL CHECKS PASS
//          (worst adjacent CVD ΔE 9.1; contrast WARN on 3 slots -> every
//          user must show visible value labels or a table, which the donut
//          legend does)
//   dark   #3987e5,#d95926,#199e70,#c98500,#d55181,#008300 -> ALL CHECKS PASS
//
// Colour follows the entity, never its rank: callers needing stable colours
// across visits key slots off a fixed category order (see `slotForKey`).
//
// Every class string is a literal so Tailwind's content scan finds it — see
// lib/reports/bar-scale.ts.
export type CategoricalStep = {
  fillClass: string
  strokeClass: string
  bgClass: string
  hex: { light: string; dark: string }
}

export const CATEGORICAL_PALETTE: readonly CategoricalStep[] = [
  {
    fillClass: 'fill-[#2a78d6] dark:fill-[#3987e5]',
    strokeClass: 'stroke-[#2a78d6] dark:stroke-[#3987e5]',
    bgClass: 'bg-[#2a78d6] dark:bg-[#3987e5]',
    hex: { light: '#2a78d6', dark: '#3987e5' },
  },
  {
    fillClass: 'fill-[#eb6834] dark:fill-[#d95926]',
    strokeClass: 'stroke-[#eb6834] dark:stroke-[#d95926]',
    bgClass: 'bg-[#eb6834] dark:bg-[#d95926]',
    hex: { light: '#eb6834', dark: '#d95926' },
  },
  {
    fillClass: 'fill-[#1baf7a] dark:fill-[#199e70]',
    strokeClass: 'stroke-[#1baf7a] dark:stroke-[#199e70]',
    bgClass: 'bg-[#1baf7a] dark:bg-[#199e70]',
    hex: { light: '#1baf7a', dark: '#199e70' },
  },
  {
    fillClass: 'fill-[#eda100] dark:fill-[#c98500]',
    strokeClass: 'stroke-[#eda100] dark:stroke-[#c98500]',
    bgClass: 'bg-[#eda100] dark:bg-[#c98500]',
    hex: { light: '#eda100', dark: '#c98500' },
  },
  {
    fillClass: 'fill-[#e87ba4] dark:fill-[#d55181]',
    strokeClass: 'stroke-[#e87ba4] dark:stroke-[#d55181]',
    bgClass: 'bg-[#e87ba4] dark:bg-[#d55181]',
    hex: { light: '#e87ba4', dark: '#d55181' },
  },
  {
    fillClass: 'fill-[#008300] dark:fill-[#008300]',
    strokeClass: 'stroke-[#008300] dark:stroke-[#008300]',
    bgClass: 'bg-[#008300] dark:bg-[#008300]',
    hex: { light: '#008300', dark: '#008300' },
  },
] as const

/** Neutral step for the "Other" fold-in bucket — never a 7th hue. */
export const OTHER_STEP: CategoricalStep = {
  fillClass: 'fill-muted-foreground',
  strokeClass: 'stroke-muted-foreground',
  bgClass: 'bg-muted-foreground',
  hex: { light: '#898781', dark: '#898781' },
}

/** Max distinct hues; anything beyond folds into "Other". */
export const MAX_CATEGORICAL = CATEGORICAL_PALETTE.length

/**
 * Stable slot for a key within a fixed, caller-supplied ordering (e.g. the
 * known list of reimbursement types), so a category keeps its colour even when
 * its rank changes. Keys not in `order`, or past slot 6, get OTHER_STEP.
 */
export function slotForKey(key: string, order: readonly string[]): CategoricalStep {
  const i = order.indexOf(key)
  return i >= 0 && i < CATEGORICAL_PALETTE.length ? CATEGORICAL_PALETTE[i]! : OTHER_STEP
}
