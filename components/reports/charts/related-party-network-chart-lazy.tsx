'use client'

import dynamic from 'next/dynamic'
import { Skeleton } from '@/components/ui/skeleton'

// Perf remediation Phase 6.4 (docs/performance-remediation-plan.md): see
// purchase-tree-chart-lazy.tsx's header for the full rationale -- same
// pattern, applied to this chart.
export const RelatedPartyNetworkChart = dynamic(
  () => import('./related-party-network-chart').then((mod) => mod.RelatedPartyNetworkChart),
  {
    ssr: false,
    loading: () => <Skeleton className="h-64 w-full" />,
  }
)
