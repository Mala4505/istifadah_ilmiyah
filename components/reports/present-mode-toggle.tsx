'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

/**
 * Present mode toggle (reporting-blueprint.md §5 "Present mode"): "a
 * full-screen, large-type, no-navigation rendering of the Brief for a
 * projector." Mechanism is a `data-present-mode` attribute on <body> that
 * app/globals.css's attribute-selector rules react to -- Server Component
 * layouts don't receive client state, so this avoids prop-drilling a present
 * flag through the whole tree for a purely presentational toggle.
 */
export function PresentModeToggle() {
  const [presentMode, setPresentMode] = useState(false)

  useEffect(() => {
    if (!presentMode) return

    document.body.dataset.presentMode = 'true'
    // Best-effort: fullscreen can be unavailable (iframe, permissions
    // policy) or rejected by the browser -- never let that block the rest
    // of the toggle.
    document.documentElement.requestFullscreen?.().catch(() => {})

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPresentMode(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      delete document.body.dataset.presentMode
      // Only exit if something is actually fullscreen -- some browsers
      // throw when exitFullscreen is called with nothing to exit.
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {})
      }
    }
  }, [presentMode])

  return (
    <Button variant="outline" size="sm" onClick={() => setPresentMode((prev) => !prev)}>
      {presentMode ? 'Exit present mode' : 'Present mode'}
    </Button>
  )
}
