'use client'

import { useMemo, useState, useTransition } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  SHORTCUT_DEFINITIONS,
  formatBinding,
  type ShortcutActionId,
  type ShortcutBinding,
  type ShortcutDefinition,
} from '@/lib/shortcuts/config'
import { saveKeymapPreferences } from '@/lib/actions/settings'

const CONFIGURABLE_DEFINITIONS = SHORTCUT_DEFINITIONS.filter((def) => def.configurable)
const FIXED_DEFINITIONS = SHORTCUT_DEFINITIONS.filter((def) => !def.configurable)

// Keydown fires once per modifier too (Alt down before the letter) -- ignore
// those so capture waits for the actual key the modifier is held with.
const MODIFIER_ONLY_KEYS = new Set(['Alt', 'Control', 'Shift', 'Meta', 'OS'])

const NO_MODIFIER_MESSAGE =
  'Shortcuts need at least one modifier key (Alt, Ctrl, or Shift) to avoid firing while typing.'

function bindingsEqual(a: ShortcutBinding, b: ShortcutBinding): boolean {
  return (
    a.key === b.key &&
    !!a.alt === !!b.alt &&
    !!a.shift === !!b.shift &&
    !!a.ctrl === !!b.ctrl &&
    !!a.meta === !!b.meta
  )
}

function overridesEqual(
  a: Partial<Record<ShortcutActionId, ShortcutBinding>>,
  b: Partial<Record<ShortcutActionId, ShortcutBinding>>
): boolean {
  return CONFIGURABLE_DEFINITIONS.every((def) => {
    const av = a[def.id]
    const bv = b[def.id]
    if (!av && !bv) return true
    if (!av || !bv) return false
    return bindingsEqual(av, bv)
  })
}

function hasAnyModifier(binding: ShortcutBinding): boolean {
  return !!binding.alt || !!binding.shift || !!binding.ctrl || !!binding.meta
}

export function KeymapSettings({
  initialOverrides,
  initialShortcutsEnabled,
}: {
  initialOverrides: Partial<Record<ShortcutActionId, ShortcutBinding>>
  initialShortcutsEnabled: boolean
}) {
  const [overrides, setOverrides] = useState(initialOverrides)
  const [shortcutsEnabled, setShortcutsEnabled] = useState(initialShortcutsEnabled)
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const isDirty = useMemo(
    () => shortcutsEnabled !== initialShortcutsEnabled || !overridesEqual(overrides, initialOverrides),
    [overrides, shortcutsEnabled, initialOverrides, initialShortcutsEnabled]
  )

  function currentBinding(def: ShortcutDefinition): ShortcutBinding {
    return overrides[def.id] ?? def.default
  }

  function handleStartCapture(actionId: ShortcutActionId) {
    setCaptureError(null)
    setRecordingActionId(actionId)
  }

  function handleCancelCapture() {
    setRecordingActionId(null)
    setCaptureError(null)
  }

  function handleCaptureKeyDown(def: ShortcutDefinition, event: ReactKeyboardEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      handleCancelCapture()
      return
    }
    if (MODIFIER_ONLY_KEYS.has(event.key)) return

    const binding: ShortcutBinding = {
      key: event.key,
      alt: event.altKey,
      shift: event.shiftKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
    }
    if (!hasAnyModifier(binding)) {
      setCaptureError(NO_MODIFIER_MESSAGE)
      return
    }
    setOverrides((prev) => ({ ...prev, [def.id]: binding }))
    setRecordingActionId(null)
    setCaptureError(null)
  }

  function handleResetRow(actionId: ShortcutActionId) {
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[actionId]
      return next
    })
    if (recordingActionId === actionId) handleCancelCapture()
  }

  function handleResetAll() {
    setOverrides({})
    handleCancelCapture()
  }

  // jumpToLineDigit is exempt from raw key capture -- its digit isn't
  // configurable at all (lib/shortcuts/config.ts: `default: { key: '', alt:
  // true }`), so the only thing to record is which modifier is held down
  // with 1-9. Three checkboxes are a simpler, more reliable UI for that than
  // listening for a raw keydown that would never see a literal digit key.
  function handleLineDigitModifierChange(
    def: ShortcutDefinition,
    field: 'alt' | 'shift' | 'ctrl',
    checked: boolean
  ) {
    const current = currentBinding(def)
    const next: ShortcutBinding = {
      key: '',
      alt: current.alt,
      shift: current.shift,
      ctrl: current.ctrl,
      meta: current.meta,
    }
    next[field] = checked
    if (!hasAnyModifier(next)) {
      setCaptureError(NO_MODIFIER_MESSAGE)
      return
    }
    setCaptureError(null)
    setOverrides((prev) => ({ ...prev, [def.id]: next }))
  }

  function handleSave() {
    startTransition(async () => {
      const result = await saveKeymapPreferences({ overrides, shortcutsEnabled })
      if (result.ok) {
        toast.success('Keyboard shortcut preferences saved.')
      } else {
        toastError(result.error, { context: 'keymap-settings' })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Checkbox
          id="shortcuts-enabled"
          checked={shortcutsEnabled}
          onCheckedChange={(checked) => setShortcutsEnabled(checked === true)}
        />
        <label htmlFor="shortcuts-enabled" className="text-sm">
          Enable keyboard shortcuts on the review screen
        </label>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Configurable</h3>
          <Button type="button" variant="ghost" size="sm" onClick={handleResetAll}>
            Reset all to defaults
          </Button>
        </div>
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {CONFIGURABLE_DEFINITIONS.map((def) => {
            const binding = currentBinding(def)
            const isOverridden = !!overrides[def.id]
            const isRecording = recordingActionId === def.id

            return (
              <div key={def.id} className="flex flex-col gap-2 p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{def.label}</p>
                    <p className="text-xs text-muted-foreground">{def.description}</p>
                  </div>

                  {def.id === 'jumpToLineDigit' ? (
                    <div className="flex shrink-0 items-center gap-3">
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={!!binding.alt}
                          onCheckedChange={(checked) =>
                            handleLineDigitModifierChange(def, 'alt', checked === true)
                          }
                        />
                        Alt
                      </label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={!!binding.ctrl}
                          onCheckedChange={(checked) =>
                            handleLineDigitModifierChange(def, 'ctrl', checked === true)
                          }
                        />
                        Ctrl
                      </label>
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={!!binding.shift}
                          onCheckedChange={(checked) =>
                            handleLineDigitModifierChange(def, 'shift', checked === true)
                          }
                        />
                        Shift
                      </label>
                      <span className="font-mono text-xs text-muted-foreground">+ 1-9</span>
                      {isOverridden && (
                        <Button type="button" variant="ghost" size="sm" onClick={() => handleResetRow(def.id)}>
                          Reset
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      {isRecording ? (
                        <button
                          type="button"
                          autoFocus
                          onKeyDown={(event) => handleCaptureKeyDown(def, event)}
                          onBlur={handleCancelCapture}
                          className="rounded-md border border-dashed border-primary px-2 py-1 text-xs text-primary"
                        >
                          Press a key combination…
                        </button>
                      ) : (
                        <>
                          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                            {formatBinding(binding)}
                          </kbd>
                          <Button type="button" variant="outline" size="sm" onClick={() => handleStartCapture(def.id)}>
                            Change
                          </Button>
                          {isOverridden && (
                            <Button type="button" variant="ghost" size="sm" onClick={() => handleResetRow(def.id)}>
                              Reset
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
                {isRecording && captureError && <p className="text-xs text-destructive">{captureError}</p>}
              </div>
            )
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Fixed</h3>
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {FIXED_DEFINITIONS.map((def) => (
            <div key={def.id} className="flex items-center justify-between gap-4 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{def.label}</p>
                <p className="text-xs text-muted-foreground">{def.description}</p>
              </div>
              <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                {formatBinding(def.default)}
              </kbd>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleSave} disabled={!isDirty || isPending}>
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {!isDirty && <span className="text-xs text-muted-foreground">No changes to save.</span>}
      </div>
    </div>
  )
}
