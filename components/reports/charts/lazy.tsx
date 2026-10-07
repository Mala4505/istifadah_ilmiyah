'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

// Lazy entry points for every Recharts-based report chart. Sections and pages
// import charts from HERE, not from the chart modules directly, so Recharts
// (~100 kB) is no longer part of any /reports route's first-load JS — it is
// fetched after hydration, only on panes that actually render a chart.
//
// `ssr: false` costs nothing visible: Recharts' ResponsiveContainer renders
// an empty box on the server anyway (it needs a measured width), so the
// server never painted these charts. The skeleton holds roughly the chart's
// height so the swap-in doesn't shift the page. Each chart still animates in
// on mount (useChartAnimation), which reads naturally after the skeleton.
//
// Same pattern as benford-chart-lazy.tsx / purchase-tree-chart-lazy.tsx
// (perf remediation Phase 6.4). Types are re-exported so call sites keep a
// single import line.

function block(height: number) {
  function ChartSkeleton() {
    return <Skeleton className="w-full" style={{ height }} />
  }
  return ChartSkeleton
}

export const TrendChart = dynamic(() => import('./trend-chart').then((m) => m.TrendChart), {
  ssr: false,
  loading: block(300),
})
export const FunnelChart = dynamic(() => import('./funnel-chart').then((m) => m.FunnelChart), {
  ssr: false,
  loading: block(180),
})
export const AttentionMapChart = dynamic(() => import('./attention-map-chart').then((m) => m.AttentionMapChart), {
  ssr: false,
  loading: block(360),
})
export const DonutChart = dynamic(() => import('./donut-chart').then((m) => m.DonutChart), {
  ssr: false,
  loading: block(140),
})
export const BudgetVsActualChart = dynamic(
  () => import('./budget-vs-actual-chart').then((m) => m.BudgetVsActualChart),
  { ssr: false, loading: block(320) }
)
export const WaterfallChart = dynamic(() => import('./waterfall-chart').then((m) => m.WaterfallChart), {
  ssr: false,
  loading: block(220),
})
export const VendorExclusivityChart = dynamic(
  () => import('./vendor-exclusivity-chart').then((m) => m.VendorExclusivityChart),
  { ssr: false, loading: block(320) }
)
export const DepartmentDependencyChart = dynamic(
  () => import('./department-dependency-chart').then((m) => m.DepartmentDependencyChart),
  { ssr: false, loading: block(320) }
)
export const ConcentrationCurveChart = dynamic(
  () => import('./concentration-curve-chart').then((m) => m.ConcentrationCurveChart),
  { ssr: false, loading: block(300) }
)
export const TaxExposureChart = dynamic(() => import('./tax-exposure-chart').then((m) => m.TaxExposureChart), {
  ssr: false,
  loading: block(320),
})
export const EntryTypeSplitChart = dynamic(() => import('./entry-type-split-chart').then((m) => m.EntryTypeSplitChart), {
  ssr: false,
  loading: block(320),
})
export const InstrumentMixChart = dynamic(() => import('./instrument-mix-chart').then((m) => m.InstrumentMixChart), {
  ssr: false,
  loading: block(320),
})
export const SpendCurveChart = dynamic(() => import('./spend-curve-chart').then((m) => m.SpendCurveChart), {
  ssr: false,
  loading: block(280),
})
export const GapDistributionChart = dynamic(
  () => import('./gap-distribution-chart').then((m) => m.GapDistributionChart),
  { ssr: false, loading: block(260) }
)
export const RateDriftChart = dynamic(() => import('./rate-drift-chart').then((m) => m.RateDriftChart), {
  ssr: false,
  loading: block(420),
})
export const QuantityByUnitChart = dynamic(() => import('./quantity-by-unit-chart').then((m) => m.QuantityByUnitChart), {
  ssr: false,
  loading: block(320),
})
export const AmountHistogramChart = dynamic(
  () => import('./amount-histogram-chart').then((m) => m.AmountHistogramChart),
  { ssr: false, loading: block(280) }
)
export const NewVendorFirstBillChart = dynamic(
  () => import('./new-vendor-first-bill-chart').then((m) => m.NewVendorFirstBillChart),
  { ssr: false, loading: block(320) }
)

export type { TrendPoint } from './trend-chart'
export type { AttentionMapPoint } from './attention-map-chart'
export type { DonutSegment, DonutValueFormat } from './donut-chart'
export type { BudgetVsActualBar } from './budget-vs-actual-chart'
export type { WaterfallStage } from './waterfall-chart'
export type { VendorExclusivityBar } from './vendor-exclusivity-chart'
export type { DepartmentDependencyBar } from './department-dependency-chart'
export type { TaxExposureDept } from './tax-exposure-chart'
export type { EntryTypeSplitDept } from './entry-type-split-chart'
export type { InstrumentMixDept } from './instrument-mix-chart'
export type { SpendCurvePoint } from './spend-curve-chart'
export type { GapDistributionBar } from './gap-distribution-chart'
export type { RateDriftChartSeries } from './rate-drift-chart'
export type { QuantityByUnitBar } from './quantity-by-unit-chart'
export type { AmountHistogramBar, AmountHistogramThreshold } from './amount-histogram-chart'
export type { NewVendorFirstBillPoint } from './new-vendor-first-bill-chart'
