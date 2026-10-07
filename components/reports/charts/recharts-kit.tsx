'use client'

// Small shared pieces for the /reports Recharts bar charts (shadcn chart base
// in components/ui/chart.tsx). Kept here so every converted chart uses the
// same tick size, grid, surface gap, status hexes and tooltip row — one
// system, not ten near-copies. Client-only (Recharts + next/navigation);
// nothing in here may be imported by a Server Component as a runtime value.

import type * as React from 'react'
import { useRouter } from 'next/navigation'
import { Rectangle, type BarShapeProps } from 'recharts'
import { useChartWidth } from './use-chart-width'

/**
 * Horizontal bar charts spend a fixed slice of width on the category labels
 * and bar-end labels; on a phone that would leave the bars a sliver. Returns
 * a ref for the chart's wrapper and whether it is narrow (< 520px) so callers
 * can shrink the label gutters and truncate harder.
 */
export function useCompactChart() {
  const [ref, width] = useChartWidth(640)
  return [ref, width < 520] as const
}

/** Card surface — the 2px gap between touching marks is drawn in this. */
export const SURFACE = 'hsl(var(--card))'
/** Axis tick text: ≥11px, muted ink (never the series colour). */
export const AXIS_TICK = { fontSize: 11, fill: 'hsl(var(--muted-foreground))' }
export const GRID_STROKE = 'hsl(var(--border))'

/** Plain series blue (dataviz slot 1) — light / dark. */
export const SERIES_BLUE = { light: '#2a78d6', dark: '#3987e5' }
/** Reserved status hexes (Tailwind amber-500/400, red-600/500) — warn, critical. */
export const STATUS_WARN = { light: '#f59e0b', dark: '#fbbf24' }
export const STATUS_CRITICAL = { light: '#dc2626', dark: '#ef4444' }

/** Row height for horizontal bar charts, so long lists grow instead of squashing. */
export const ROW_PX = 32
/** Bar thickness cap (dataviz: ≤24px; thin bars). */
export const BAR_PX = 16

export function horizontalChartHeight(rows: number, axisPx = 32): number {
  return rows * ROW_PX + axisPx
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

type TickProps = { x?: number | string; y?: number | string; payload?: { value?: unknown } }

/**
 * Category-axis tick for horizontal bar charts. The axis is keyed by a unique
 * row id; `lookup` maps it to the visible label (+ optional drill link).
 * Long names truncate with a <title> carrying the full text. A linked label is
 * an SVG <a> — focusable and Enter-activated, so keyboard users get the same
 * drill-through as a click on the bar.
 */
export function CategoryTick({
  x,
  y,
  payload,
  lookup,
  maxChars = 22,
}: TickProps & {
  lookup: (key: string) => { label: string; href?: string | null } | undefined
  maxChars?: number
}) {
  const router = useRouter()
  const row = lookup(String(payload?.value ?? ''))
  if (!row) return null
  const text = (
    <text x={-8} y={0} dy={4} textAnchor="end" fontSize={11} className="fill-foreground">
      <title>{row.label}</title>
      {truncate(row.label, maxChars)}
    </text>
  )
  return (
    <g transform={`translate(${Number(x ?? 0)},${Number(y ?? 0)})`}>
      {row.href ? (
        <a
          href={row.href}
          className="cursor-pointer outline-none [&:focus-visible_text]:underline [&:hover_text]:underline"
          onClick={(e) => {
            e.preventDefault()
            router.push(row.href!)
          }}
        >
          {text}
        </a>
      ) : (
        text
      )}
    </g>
  )
}

/**
 * Category-axis tick for vertical (column) charts: wraps a long bucket label
 * onto two lines at a dash or space instead of letting Recharts hide it.
 */
export function WrappingTick({ x, y, payload, format }: TickProps & { format?: (v: string) => string }) {
  const raw = String(payload?.value ?? '')
  const label = format ? format(raw) : raw
  let lines = [label]
  if (label.length > 8) {
    const dash = label.indexOf('–')
    const dashHyphen = dash === -1 ? label.indexOf('-') : dash
    const space = label.lastIndexOf(' ')
    if (dashHyphen > 0) lines = [label.slice(0, dashHyphen + 1), label.slice(dashHyphen + 1)]
    else if (space > 0) lines = [label.slice(0, space), label.slice(space + 1)]
  }
  return (
    <g transform={`translate(${Number(x ?? 0)},${Number(y ?? 0)})`}>
      <text x={0} y={0} textAnchor="middle" fontSize={11} fill={AXIS_TICK.fill}>
        <title>{label}</title>
        {lines.map((l, i) => (
          <tspan key={i} x={0} dy={i === 0 ? 12 : 13}>
            {l}
          </tspan>
        ))}
      </text>
    </g>
  )
}

/** One tooltip line: colour key, muted name, value in mono foreground ink. */
export function TooltipRow({
  color,
  name,
  value,
  sub,
}: {
  color?: string
  name: React.ReactNode
  value: React.ReactNode
  sub?: React.ReactNode
}) {
  return (
    <div className="flex w-full items-center gap-2">
      {color && <span className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: color }} />}
      <div className="flex flex-1 items-center justify-between gap-3 leading-none">
        <span className="text-muted-foreground">{name}</span>
        <span className="font-mono font-medium tabular-nums text-foreground">
          {value}
          {sub != null && <span className="ml-1 text-muted-foreground">{sub}</span>}
        </span>
      </div>
    </div>
  )
}

type LabelBox = {
  x?: number | string
  y?: number | string
  width?: number | string
  height?: number | string
  index?: number
}

/**
 * <LabelList content> for horizontal bars: renders `render(index)` (SVG
 * children) just past the bar's data end, vertically centred on the bar.
 */
export function barEndLabel(render: (index: number) => React.ReactNode, dx = 6) {
  function BarEndLabel(props: LabelBox) {
    const x = Number(props.x ?? 0) + Number(props.width ?? 0) + dx
    const y = Number(props.y ?? 0) + Number(props.height ?? 0) / 2
    return <g transform={`translate(${x},${y})`}>{render(props.index ?? 0)}</g>
  }
  return BarEndLabel
}

/**
 * Bar shape for stacked horizontal bars: rounds only the data end of the row's
 * LAST non-zero segment (square at the baseline and between segments), and
 * draws the 2px surface gap as a surface-coloured stroke.
 */
export function stackedSegmentShape(isLast: (payload: unknown) => boolean, clickable: boolean) {
  function StackedSegment(props: BarShapeProps) {
    return (
      <Rectangle
        {...props}
        radius={isLast(props.payload) ? [0, 4, 4, 0] : 0}
        stroke={SURFACE}
        strokeWidth={2}
        className={clickable ? 'cursor-pointer' : undefined}
      />
    )
  }
  return StackedSegment
}
