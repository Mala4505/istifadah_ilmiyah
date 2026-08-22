'use client'

// `?` -- keyboard shortcut overlay (§7, last row of the table). Rows are
// generated from SHORTCUT_DEFINITIONS (plan §2.1) rather than a hardcoded
// table, so this overlay always reflects the viewer's actual current
// bindings -- their own remaps for configurable actions, the fixed default
// for the rest.

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SHORTCUT_DEFINITIONS, formatBinding, type Keymap } from '@/lib/shortcuts/config'

export function ShortcutsOverlay({
  open,
  onOpenChange,
  keymap,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  keymap: Keymap
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <div className="contents">
            <dt>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                Tab / Shift-Tab
              </kbd>
            </dt>
            <dd className="text-muted-foreground">Next / previous field</dd>
          </div>
          <div className="contents">
            <dt>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">Enter</kbd>
            </dt>
            <dd className="text-muted-foreground">Accept the OCR value as verified and advance</dd>
          </div>
          {SHORTCUT_DEFINITIONS.map((def) => (
            <div key={def.id} className="contents">
              <dt>
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {formatBinding(def.configurable ? keymap[def.id] : def.default)}
                </kbd>
              </dt>
              <dd className="text-muted-foreground">{def.label}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Configurable shortcuts only act outside a focused text field, and only while the shortcuts toggle is on --
          typing amounts and notes is never intercepted. Remap them from Settings.
        </p>
      </DialogContent>
    </Dialog>
  )
}
