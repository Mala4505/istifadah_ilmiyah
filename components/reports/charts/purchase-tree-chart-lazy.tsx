'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

// Perf remediation Phase 6.4 (docs/performance-remediation-plan.md): one of
// the three heaviest, lowest-priority-to-hydrate-immediately chart
// components (the other two: related-party-network-chart, benford-chart).
// `next/dynamic` with `ssr: false` is only valid inside a Client Component
// (Next throws a build error if used directly in a Server Component) --
// components/reports/sections/purchase-tree.tsx that renders this chart is
// a plain Server Component, so this tiny client wrapper exists solely to
// host the dynamic import, mirroring the established `PdfViewer` pattern
// (components/review/review-workspace.tsx) of a dynamic, ssr:false import
// with a dimension-matched loading skeleton.
export const PurchaseTreeChart = dynamic(() => import('./purchase-tree-chart').then((mod) => mod.PurchaseTreeChart), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
})
