'use client'

import { useEffect, useRef, useState } from 'react'

// Measures a chart's container so SVG charts lay out at their real pixel
// width (viewBox width === rendered width, scale 1). A fixed viewBox with a
// fixed height letterboxes on wide cards and shrinks 9px labels to ~5px on a
// phone; laying out at the measured width avoids both. `fallback` is the
// width used for the server render and first paint, before the observer
// reports — pass the chart's old fixed VIEW_WIDTH so SSR output is unchanged.
// SVG geometry is attributes, not CSS, so this is unaffected by the app's
// style-src CSP constraint (lib/reports/bar-scale.ts).
export function useChartWidth<T extends HTMLElement = HTMLDivElement>(fallback: number, min = 280) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      if (w > 0) setWidth(Math.max(min, Math.round(w)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [min])

  return [ref, width] as const
}
