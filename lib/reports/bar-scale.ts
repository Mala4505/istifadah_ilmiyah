// Snaps a 0-100 percentage to a 5% step and looks up a *literal* Tailwind
// class name for it.
//
// Why not `style={{ width: `${pct}%` }}`: middleware.ts's production CSP
// (§4.4b) ships `style-src 'self' 'nonce-…'` with no `'unsafe-inline'`. A
// script/style nonce only covers <script>/<style> elements, never the
// `style=""` HTML attribute, so an inline style attribute is silently
// dropped by the browser in production even though report-only + dev mode
// (which does carry 'unsafe-inline' for style-src) won't show anything
// wrong. Building the class name from a template string at runtime doesn't
// fix it either — Tailwind's compiler finds classes by scanning the raw
// source text listed in tailwind.config.ts's `content` globs, not by
// executing the code, so a computed `w-[${pct}%]` is invisible to it. The
// literal strings below are what make the classes exist in the compiled
// CSS at all.
const WIDTH_CLASS = {
  0: 'w-0',
  5: 'w-[5%]',
  10: 'w-[10%]',
  15: 'w-[15%]',
  20: 'w-[20%]',
  25: 'w-1/4',
  30: 'w-[30%]',
  35: 'w-[35%]',
  40: 'w-[40%]',
  45: 'w-[45%]',
  50: 'w-1/2',
  55: 'w-[55%]',
  60: 'w-[60%]',
  65: 'w-[65%]',
  70: 'w-[70%]',
  75: 'w-3/4',
  80: 'w-[80%]',
  85: 'w-[85%]',
  90: 'w-[90%]',
  95: 'w-[95%]',
  100: 'w-full',
} as const

const LEFT_CLASS = {
  0: 'left-0',
  5: 'left-[5%]',
  10: 'left-[10%]',
  15: 'left-[15%]',
  20: 'left-[20%]',
  25: 'left-1/4',
  30: 'left-[30%]',
  35: 'left-[35%]',
  40: 'left-[40%]',
  45: 'left-[45%]',
  50: 'left-1/2',
  55: 'left-[55%]',
  60: 'left-[60%]',
  65: 'left-[65%]',
  70: 'left-[70%]',
  75: 'left-3/4',
  80: 'left-[80%]',
  85: 'left-[85%]',
  90: 'left-[90%]',
  95: 'left-[95%]',
  100: 'left-[99%]', // 100% would sit the 2px marker just off the right edge
} as const

type Step = keyof typeof WIDTH_CLASS

function snapTo5(pct: number): Step {
  const clamped = Math.max(0, Math.min(100, pct))
  return (Math.round(clamped / 5) * 5) as Step
}

export function barWidthClass(pct: number): string {
  return WIDTH_CLASS[snapTo5(pct)]
}

export function barLeftClass(pct: number): string {
  return LEFT_CLASS[snapTo5(pct)]
}
