'use client'

import { Label, Pie, PieChart, Sector, type PieSectorShapeProps } from 'recharts'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatNumber, formatPercent } from '@/lib/reports/format'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  useChartAnimation,
  type ChartConfig,
} from '@/components/ui/chart'

// Part-to-whole ring on shadcn charts (Recharts 3). One calm entry animation
// via useChartAnimation() (off under prefers-reduced-motion), a hover tooltip
// per segment (dataviz skill: hover layer by default), the centre label as a
// Recharts <Label>, and the legend list -- every value directly labeled, so
// identity is never colour-only -- beside the ring on sm+.
//
// CSP: Recharts' inline style props and ChartContainer's injected <style> are
// allowed (style-src 'unsafe-inline', see components/ui/chart.tsx). The
// legend swatches stay plain SVG attributes + literal classes.

const SIZE = 140
const OUTER_RADIUS = 68
// 24px ring: >=24px per the dataviz skill's hover-target minimum, since the
// ring itself is the hit area.
const INNER_RADIUS = OUTER_RADIUS - 24

// A format *name*, not a function prop: most callers are Server Component
// sections, and a function reference can't cross the client boundary (same
// reason as trend-chart.tsx's FORMATTERS). Resolved locally on the client.
const FORMATTERS = { number: formatNumber, 'inr-compact': formatINRCompact } as const
export type DonutValueFormat = keyof typeof FORMATTERS

export type DonutSegment = {
  key: string
  label: string
  value: number
  /**
   * A literal Tailwind `stroke-[...]` class (with a `dark:stroke-[...]`
   * pair) — used for the legend swatch, and parsed for the ring colour when
   * `hex` is absent (`stroke-[#rrggbb]` arbitrary values and the few named
   * status classes in NAMED_STROKE_HEX resolve; anything else falls back to
   * muted grey). Stroke-only so a `fill-*` can't collide with the swatch's
   * `fill-none`.
   */
  colorClass: string
  /** Explicit ring colour per theme. Wins over parsing `colorClass`. */
  hex?: { light: string; dark: string }
}

const MUTED = 'hsl(var(--muted-foreground))'

// Named Tailwind stroke classes that donut callers use for reserved status /
// neutral colours (severity, reimbursement amber, "Other"). Tailwind v3
// palette hexes.
const NAMED_STROKE_HEX: Record<string, string> = {
  'stroke-red-600': '#dc2626',
  'stroke-red-400': '#f87171',
  'stroke-amber-500': '#f59e0b',
  'stroke-amber-400': '#fbbf24',
  'stroke-muted-foreground': MUTED,
  'stroke-muted-foreground/40': 'hsl(var(--muted-foreground) / 0.4)',
}

function resolveToken(token: string | undefined): string | null {
  if (!token) return null
  const arbitrary = /^stroke-\[(#[0-9a-fA-F]{3,8})\]$/.exec(token)
  if (arbitrary) return arbitrary[1]!
  return NAMED_STROKE_HEX[token] ?? null
}

function segmentTheme(seg: DonutSegment): { light: string; dark: string } {
  if (seg.hex) return seg.hex
  const tokens = seg.colorClass.split(/\s+/)
  const light = resolveToken(tokens.find((t) => !t.startsWith('dark:')))
  const dark = resolveToken(tokens.find((t) => t.startsWith('dark:'))?.slice('dark:'.length))
  return { light: light ?? MUTED, dark: dark ?? light ?? MUTED }
}

/** Greedy word wrap for the centre label (≤ 3 lines of ~10 chars) so it
 *  stays inside the ring's hole. */
function wrapCenter(text: string, max = 10): string[] {
  const lines: string[] = []
  for (const word of text.split(/\s+/)) {
    const last = lines[lines.length - 1]
    if (last != null && (last + ' ' + word).length <= max) lines[lines.length - 1] = `${last} ${word}`
    else lines.push(word)
  }
  return lines.slice(0, 3)
}

type Datum = {
  key: string
  name: string
  value: number
  fraction: number
  fill: string
}

export function DonutChart({
  segments,
  centerLabel,
  selectedKey,
  onSelect,
  valueFormat = 'number',
}: {
  segments: DonutSegment[]
  centerLabel?: string
  selectedKey?: string | null
  onSelect?: (key: string) => void
  /** How each segment's value renders in the legend and the tooltip —
   *  'inr-compact' for a money-valued donut. Defaults to 'number' (counts). */
  valueFormat?: DonutValueFormat
}) {
  const animation = useChartAnimation()
  const valueFormatter = FORMATTERS[valueFormat]
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (segments.length === 0 || total <= 0) return null

  // ChartConfig keys are positional (s0, s1, …): segment keys are arbitrary
  // ids that may not be valid CSS custom-property names.
  const config: ChartConfig = {}
  const data: Datum[] = segments.map((s, i) => {
    config[`s${i}`] = { label: s.label, theme: segmentTheme(s) }
    return { key: s.key, name: s.label, value: s.value, fraction: s.value / total, fill: `var(--color-s${i})` }
  })

  const centerLines = centerLabel ? wrapCenter(centerLabel) : []

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <ChartContainer config={config} className="aspect-square h-[140px] w-[140px] shrink-0">
        <PieChart width={SIZE} height={SIZE}>
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideLabel
                // The ring is only 140px wide; without a floor the tooltip
                // squeezes a long segment name onto 3-4 lines.
                className="min-w-[13rem]"
                formatter={(value, _name, item) => {
                  const d = item.payload as Datum | undefined
                  return (
                    <div className="flex w-full items-center gap-2">
                      <svg width={10} height={10} viewBox="0 0 10 10" className="shrink-0" aria-hidden="true">
                        <rect width={10} height={10} rx={2} fill={d?.fill} />
                      </svg>
                      <span className="text-muted-foreground">{d?.name}</span>
                      <span className="ml-auto pl-2 font-mono font-medium tabular-nums text-foreground">
                        {valueFormatter(Number(value))} · {formatPercent((d?.fraction ?? 0) * 100)}
                      </span>
                    </div>
                  )
                }}
              />
            }
          />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={INNER_RADIUS}
            outerRadius={OUTER_RADIUS}
            startAngle={90}
            endAngle={-270}
            // 2px surface ring between segments (dataviz mark spec) — the card
            // colour, so it reads as a gap rather than a border.
            stroke="hsl(var(--card))"
            strokeWidth={2}
            onClick={onSelect ? (d) => onSelect((d.payload as Datum).key) : undefined}
            className={cn(onSelect && 'cursor-pointer')}
            shape={(props: PieSectorShapeProps) => {
              // Recharts hands `key` inside the props object; React 19 warns when
              // a key is spread, so pass it explicitly.
              const { key: reactKey, ...sectorProps } = props as PieSectorShapeProps & { key?: React.Key }
              const key = (props.payload as Datum | undefined)?.key
              const dimmed = selectedKey != null && key !== selectedKey
              return <Sector key={reactKey} {...sectorProps} fillOpacity={dimmed ? 0.4 : 1} />
            }}
            {...animation}
          >
            {centerLines.length > 0 && (
              <Label
                position="center"
                content={({ viewBox }) => {
                  // Recharts 3 resolves position="center" against the chart's
                  // cartesian box ({x, y, width, height}), not the polar one,
                  // so take the centre from whichever shape arrives.
                  if (!viewBox) return null
                  const cx = 'cx' in viewBox ? viewBox.cx : 'width' in viewBox ? (viewBox.x ?? 0) + (viewBox.width ?? 0) / 2 : null
                  const cy = 'cy' in viewBox ? viewBox.cy : 'height' in viewBox ? (viewBox.y ?? 0) + (viewBox.height ?? 0) / 2 : null
                  if (cx == null || cy == null) return null
                  const lineHeight = 14
                  const top = cy - ((centerLines.length - 1) * lineHeight) / 2
                  return (
                    <text textAnchor="middle" dominantBaseline="middle" className="fill-foreground text-xs font-medium">
                      {centerLines.map((line, i) => (
                        <tspan key={i} x={cx} y={top + i * lineHeight}>
                          {line}
                        </tspan>
                      ))}
                    </text>
                  )
                }}
              />
            )}
          </Pie>
        </PieChart>
      </ChartContainer>
      {/* A legend is always rendered (2+ segments per the dataviz skill's rule)
          with every value directly labeled — identity is never color-only.
          It is also the keyboard path for selection. */}
      <ul className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
        {segments.map((seg, i) => {
          const isSelected = selectedKey === seg.key
          return (
            <li key={seg.key}>
              <button
                type="button"
                onClick={onSelect ? () => onSelect(seg.key) : undefined}
                disabled={!onSelect}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-1 py-1 text-left transition-colors disabled:cursor-default',
                  onSelect && 'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isSelected && 'bg-accent/60'
                )}
              >
                <svg width={10} height={10} viewBox="0 0 10 10" className="shrink-0" aria-hidden="true">
                  <circle cx={5} cy={5} r={4} strokeWidth={2} className={cn('fill-none', seg.colorClass)} />
                </svg>
                <span className="flex-1 truncate text-foreground">{seg.label}</span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {valueFormatter(seg.value)} · {formatPercent(data[i]!.fraction * 100)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
