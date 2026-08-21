'use client'

// `?` -- keyboard shortcut overlay (§7, last row of the table).

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const SHORTCUTS: [string, string][] = [
  ['Tab / Shift-Tab', 'Next / previous field'],
  ['Enter', 'Accept the OCR value as verified and advance'],
  ['Cmd/Ctrl-Enter', 'Accept all remaining unedited fields and save'],
  ['Page Down / Page Up', 'Next / previous document'],
  ['→ / ↓', 'Next page of the current document'],
  ['← / ↑', 'Previous page of the current document'],
  ['E', 'Flag as exception, with a note'],
  ['Shift+R', 'Re-run extraction (Sonnet) -- confirms first if you have unsaved edits'],
  ['1-9', 'Jump to line item n'],
  ['/', 'Focus vendor autocomplete'],
  ['S', 'Set Hub status, with a note'],
  ['\\', 'Cycle PDF pane: Split / Collapsed / Document'],
  ['H', 'Focus the admin head select (stage 3, Classify)'],
  ['Z', 'Focus the zone select (stage 3, Classify)'],
  ['?', 'This overlay'],
]

export function ShortcutsOverlay({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([key, action]) => (
            <div key={key} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{key}</kbd>
              </dt>
              <dd className="text-muted-foreground">{action}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Page Up/Down, arrows, E, Shift+R, digits, /, S, \, Z and H only act outside a focused text field -- typing
          amounts and notes is never intercepted.
        </p>
      </DialogContent>
    </Dialog>
  )
}
