'use client'

import dynamic from 'next/dynamic'

// Task 7.7 (docs/performance-remediation-plan.md): app/(app)/layout.tsx is a
// Server Component and can't call next/dynamic({ ssr: false }) directly, so
// this tiny client wrapper does the dynamic import instead -- same pattern
// already used for PdfViewer (review-workspace.tsx) and the lazy chart
// wrappers (benford-chart-lazy.tsx and friends). No loading fallback: the
// palette renders nothing until Alt+K opens it, so there is nothing to show
// in its place while the chunk loads.
export const CommandPalette = dynamic(
  () => import('./command-palette').then((mod) => mod.CommandPalette),
  { ssr: false }
)
