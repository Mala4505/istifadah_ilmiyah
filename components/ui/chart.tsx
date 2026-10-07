'use client'

// shadcn/ui chart primitives (https://ui.shadcn.com/charts), hand-ported for
// this repo's Tailwind 3 + Recharts 3 setup instead of `npx shadcn add chart`
// (the CLI needs a components.json / `shadcn init`, which would rewrite the
// Tailwind 3 config). Same API as upstream: ChartContainer injects one
// `--color-<key>` CSS variable per ChartConfig entry (light + dark), and
// series reference them as `var(--color-<key>)`.
//
// CSP note: ChartStyle renders an inline <style> and Recharts sets inline
// style props — both fine, style-src is 'unsafe-inline' (middleware.ts).
//
// Animation: `useChartAnimation()` gives every chart the same short, calm
// entry animation and switches it off under prefers-reduced-motion. Finance
// charts animate once on mount, never on hover/loop.

import * as React from 'react'
import * as RechartsPrimitive from 'recharts'
import { cn } from '@/lib/utils'

const THEMES = { light: '', dark: '.dark' } as const

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
  } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> })
}

type ChartContextProps = { config: ChartConfig }

const ChartContext = React.createContext<ChartContextProps | null>(null)

export function useChart() {
  const context = React.useContext(ChartContext)
  if (!context) throw new Error('useChart must be used within a <ChartContainer />')
  return context
}

export function ChartContainer({
  id,
  className,
  children,
  config,
  ...props
}: React.ComponentProps<'div'> & {
  config: ChartConfig
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>['children']
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, '')}`

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-sector]:outline-none [&_.recharts-surface]:outline-none [&_.recharts-wrapper_svg:focus:not(:focus-visible)]:outline-none [&_.recharts-wrapper:focus:not(:focus-visible)]:outline-none [&_[tabindex='-1']:focus]:outline-none",
          className
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

export function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, c]) => c.theme || c.color)
  if (!colorConfig.length) return null

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .filter(Boolean)
  .join('\n')}
}
`
          )
          .join('\n'),
      }}
    />
  )
}

export const ChartTooltip = RechartsPrimitive.Tooltip

type TooltipItem = {
  name?: string | number
  value?: unknown
  dataKey?: string | number | ((obj: unknown) => unknown)
  color?: string
  fill?: string
  payload?: Record<string, unknown>
  type?: string
}

export function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = 'dot',
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: {
  active?: boolean
  payload?: readonly TooltipItem[]
  label?: React.ReactNode
  className?: string
  indicator?: 'line' | 'dot' | 'dashed'
  hideLabel?: boolean
  hideIndicator?: boolean
  labelFormatter?: (label: React.ReactNode, payload: readonly TooltipItem[]) => React.ReactNode
  labelClassName?: string
  formatter?: (value: unknown, name: string, item: TooltipItem, index: number, payload: unknown) => React.ReactNode
  color?: string
  nameKey?: string
  labelKey?: string
}) {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null
    const [item] = payload
    const key = `${labelKey || item?.dataKey || item?.name || 'value'}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === 'string' ? config[label as keyof typeof config]?.label || label : itemConfig?.label

    if (labelFormatter) {
      return <div className={cn('font-medium', labelClassName)}>{labelFormatter(value ?? label, payload)}</div>
    }
    if (!value) return null
    return <div className={cn('font-medium', labelClassName)}>{value}</div>
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey])

  if (!active || !payload?.length) return null

  const nestLabel = payload.length === 1 && indicator !== 'dot'

  return (
    <div
      className={cn(
        'grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl',
        className
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== 'none')
          .map((item, index) => {
            const key = `${nameKey || item.name || item.dataKey || 'value'}`
            const itemConfig = getPayloadConfigFromPayload(config, item, key)
            const indicatorColor = color || (item.payload?.fill as string | undefined) || item.color

            return (
              <div
                key={`${String(item.dataKey)}-${index}`}
                className={cn(
                  'flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground',
                  indicator === 'dot' && 'items-center'
                )}
              >
                {formatter && item?.value !== undefined && item.name !== undefined ? (
                  formatter(item.value, String(item.name), item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn('shrink-0 rounded-[2px] border-[--color-border] bg-[--color-bg]', {
                            'h-2.5 w-2.5': indicator === 'dot',
                            'w-1': indicator === 'line',
                            'w-0 border-[1.5px] border-dashed bg-transparent': indicator === 'dashed',
                            'my-0.5': nestLabel && indicator === 'dashed',
                          })}
                          style={{ '--color-bg': indicatorColor, '--color-border': indicatorColor } as React.CSSProperties}
                        />
                      )
                    )}
                    <div
                      className={cn('flex flex-1 justify-between leading-none', nestLabel ? 'items-end' : 'items-center')}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">{itemConfig?.label || item.name}</span>
                      </div>
                      {item.value != null && (
                        <span className="font-mono font-medium tabular-nums text-foreground">
                          {typeof item.value === 'number' ? item.value.toLocaleString('en-IN') : String(item.value)}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

export const ChartLegend = RechartsPrimitive.Legend

type LegendItem = { value?: unknown; dataKey?: unknown; color?: string; type?: string }

export function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = 'bottom',
  nameKey,
}: {
  className?: string
  hideIcon?: boolean
  payload?: readonly LegendItem[]
  verticalAlign?: 'top' | 'bottom' | 'middle'
  nameKey?: string
}) {
  const { config } = useChart()
  if (!payload?.length) return null

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5', verticalAlign === 'top' ? 'pb-3' : 'pt-3', className)}>
      {payload
        .filter((item) => item.type !== 'none')
        .map((item) => {
          const key = `${nameKey || item.dataKey || 'value'}`
          const itemConfig = getPayloadConfigFromPayload(config, item, key)
          return (
            <div key={String(item.value)} className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground">
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
              )}
              <span className="text-muted-foreground">{itemConfig?.label ?? String(item.value)}</span>
            </div>
          )
        })}
    </div>
  )
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const inner =
    'payload' in payload && typeof payload.payload === 'object' && payload.payload !== null ? payload.payload : undefined

  let configLabelKey: string = key
  if (key in payload && typeof payload[key as keyof typeof payload] === 'string') {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (inner && key in inner && typeof inner[key as keyof typeof inner] === 'string') {
    configLabelKey = inner[key as keyof typeof inner] as string
  }
  return configLabelKey in config ? config[configLabelKey] : config[key]
}

/**
 * Shared entry-animation settings for every Recharts series in /reports:
 * one short ease-out on mount, disabled under prefers-reduced-motion.
 * Spread onto a series: `<Bar {...anim} />`.
 */
export function useChartAnimation() {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduced(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return {
    isAnimationActive: !reduced,
    animationDuration: 450,
    animationEasing: 'ease-out' as const,
  }
}
