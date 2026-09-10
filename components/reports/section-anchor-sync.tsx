'use client'

/**
 * Anchor back-compat for the Reports workspace (redesign plan Phase 3.3).
 * Before the workspace split, every section on a surface lived in one long
 * scroll and was linked as `#<section-id>`. Now a section is addressed as
 * `?report=<section-id>` so the pane can render it alone. Old links,
 * bookmarks and in-page `#` anchors still arrive with a hash — on mount,
 * rewrite a recognised `#<id>` to `?report=<id>` (via `history.replace`, so
 * it doesn't add a back-button entry), then let the page re-render on the
 * new param.
 *
 * Rendered once from app/(app)/reports/layout.tsx, so it covers every
 * surface. No-ops when the hash is empty or not a known section id.
 */
import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ALL_SECTION_IDS } from '@/lib/reports/surface-sections'

export function SectionAnchorSync() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '')
    if (!hash || !ALL_SECTION_IDS.has(hash)) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('report') === hash) return
    params.set('report', hash)
    router.replace(`${pathname}?${params.toString()}`)
  }, [router, pathname])

  return null
}
