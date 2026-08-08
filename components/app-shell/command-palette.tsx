'use client'

import { useEffect, useState } from 'react'
import { Command } from 'cmdk'

// Cmd/Ctrl-K command palette shell (MASTER-PLAN §5 "Navigation" — jump to
// entry by UBBL, Main number, or invoice number). Wired to open/close only;
// search logic depends on entries/documents data that doesn't exist until
// the SQL migrations and entries list land. Full logic is later work.
export function CommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        setOpen((current) => !current)
      }
      if (event.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Jump to entry"
      className="fixed left-1/2 top-24 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <Command.Input
        placeholder="Jump to entry by UBBL, Main number, or invoice number…"
        className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-2 py-8 text-center text-sm text-muted-foreground">
          Command palette search is not wired up yet — coming later in Phase 1A.
        </Command.Empty>
      </Command.List>
    </Command.Dialog>
  )
}
