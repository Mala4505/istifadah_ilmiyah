'use client'

import { HelpCircle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * The `?` affordance on a Settings list row (Phase 2, Direction A). The
 * row shows only a short label + a plain-text sublabel; the longer
 * "what is this / when would I touch it" copy lives behind this popover
 * so the list itself stays scannable. Same Radix Popover the nav rail's
 * account menu uses.
 */
export function SettingsRowHelp({ label, description }: { label: string; description: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`About ${label}`}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 text-sm leading-relaxed text-muted-foreground">
        <p className="mb-1 font-medium text-foreground">{label}</p>
        {description}
      </PopoverContent>
    </Popover>
  )
}
