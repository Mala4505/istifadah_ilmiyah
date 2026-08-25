// Small inline trend line for a KpiTile — server-renderable, no interaction
// (dataviz skill: a sparkline is decoration on a stat tile, the tile's own
// value/delta carry the number). Built as plain SVG with numeric attributes
// computed directly from `values`, which is fine under this app's CSP
// constraint (lib/reports/bar-scale.ts) — that constraint is about
// *CSS* width/position on HTML elements; SVG geometry attributes aren't CSS
// and are untouched by style-src.
const WIDTH = 64
const HEIGHT = 20
const PADDING = 2

export function Sparkline({ values, width = WIDTH, height = HEIGHT }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1

  const points = values.map((v, i) => {
    const x = PADDING + (i / (values.length - 1)) * (width - PADDING * 2)
    const y = PADDING + (1 - (v - min) / range) * (height - PADDING * 2)
    return [x, y] as const
  })

  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  // values.length >= 2 was checked above, so index 0 and the last index are always present.
  const [firstX] = points[0]!
  const [lastX, lastY] = points[points.length - 1]!
  const areaPath = `${linePath} L${lastX.toFixed(2)},${height} L${firstX.toFixed(2)},${height} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="overflow-visible"
      aria-hidden="true"
    >
      {/* Area fill: series hue at ~12% opacity, a wash never a saturated block. */}
      <path d={areaPath} className="fill-[#2a78d6]/[0.12] dark:fill-[#3987e5]/[0.12]" />
      {/* Line: de-emphasis/muted color, not the accent — the end-dot alone carries the accent. */}
      <path d={linePath} className="fill-none stroke-muted-foreground" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={2.5} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
    </svg>
  )
}
