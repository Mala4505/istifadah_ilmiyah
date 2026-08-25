// A 4-step ordinal ramp derived from this screen's single accent hue
// (bar-list.tsx's `#2a78d6` light / `#3987e5` dark), for charts whose color
// encodes *position in a fixed sequence* — Hub-status donut stages,
// pipeline/funnel stages — per the dataviz skill's ordinal-color rule (one
// hue, monotone lightness steps, never a generated/cycled hue).
//
// Steps come straight from the dataviz skill's documented sequential-blue
// ramp (references/palette.md), snapped to the ordinal bounds that ramp
// documents (light: no lighter than step 250; dark: no darker than step
// 600). Validated with the skill's validator, `--ordinal` mode:
//   light  #86b6ef,#5598e7,#2a78d6,#184f95  -> ALL CHECKS PASS
//          (adjacent ΔL >= 0.06, light-end contrast 2.06:1 vs #fcfcfb)
//   dark   #6da7ec,#3987e5,#256abf,#184f95  -> ALL CHECKS PASS
//          (adjacent ΔL >= 0.06, dark-end contrast 2.15:1 vs #1a1a19)
//
// Every class string below is a literal (never built from a template at
// runtime) so Tailwind's content scan can find it — see
// lib/reports/bar-scale.ts's header comment for why that matters here.
// `fillClass` is for filled shapes (funnel bars); `strokeClass` is for
// stroke-drawn shapes (the donut's ring segments and legend swatches — see
// donut-chart.tsx for why that component sticks to stroke only).
export type OrdinalStep = {
  fillClass: string
  strokeClass: string
  hex: { light: string; dark: string }
}

export const ORDINAL_RAMP: readonly OrdinalStep[] = [
  {
    fillClass: 'fill-[#86b6ef] dark:fill-[#6da7ec]',
    strokeClass: 'stroke-[#86b6ef] dark:stroke-[#6da7ec]',
    hex: { light: '#86b6ef', dark: '#6da7ec' },
  },
  {
    fillClass: 'fill-[#5598e7] dark:fill-[#3987e5]',
    strokeClass: 'stroke-[#5598e7] dark:stroke-[#3987e5]',
    hex: { light: '#5598e7', dark: '#3987e5' },
  },
  {
    fillClass: 'fill-[#2a78d6] dark:fill-[#256abf]',
    strokeClass: 'stroke-[#2a78d6] dark:stroke-[#256abf]',
    hex: { light: '#2a78d6', dark: '#256abf' },
  },
  {
    fillClass: 'fill-[#184f95] dark:fill-[#184f95]',
    strokeClass: 'stroke-[#184f95] dark:stroke-[#184f95]',
    hex: { light: '#184f95', dark: '#184f95' },
  },
] as const
