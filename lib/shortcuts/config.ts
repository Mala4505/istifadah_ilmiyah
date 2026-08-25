/**
 * Shared contract for the /review keyboard shortcut system (plan §2.1).
 *
 * This is the single source of truth for: which actions exist, their default
 * bindings, how a binding is matched against a KeyboardEvent, how a user's
 * stored overrides merge with the defaults, and the inverted focus guard.
 *
 * Consumed by:
 *  - components/review/review-workspace.tsx (applies the resolved keymap)
 *  - components/review/shortcuts-overlay.tsx (renders the resolved keymap)
 *  - app/(app)/settings/page.tsx + its keymap editor (lets a user remap)
 *  - lib/actions/settings.ts (validates + persists overrides)
 */

export type ShortcutActionId =
  | 'toggleHelp'
  | 'cyclePane'
  | 'openException'
  | 'reExtract'
  | 'openHubStatus'
  | 'openVendorAutocomplete'
  | 'focusZone'
  | 'focusAdminHead'
  | 'jumpToLineDigit'
  | 'nextDocument'
  | 'prevDocument'
  | 'nextPageImage'
  | 'prevPageImage'
  | 'saveAndNext'

export interface ShortcutBinding {
  /** Matched against KeyboardEvent.key (case-insensitive for letters). */
  key: string
  alt?: boolean
  shift?: boolean
  ctrl?: boolean
  meta?: boolean
}

export interface ShortcutDefinition {
  id: ShortcutActionId
  label: string
  description: string
  default: ShortcutBinding
  /** Non-configurable bindings are still shown in the help overlay and
   *  settings screen, but the settings UI does not offer a remap control. */
  configurable: boolean
}

/**
 * Every configurable binding requires Alt (enforced in matchesBinding/
 * matchLineDigit below, and again server-side in
 * lib/actions/settings.ts's saveKeymapPreferences) so that neither bare
 * typing, nor a Ctrl/Shift text-editing combo (select-all, copy, a
 * capitalized letter), can ever fire a command by accident -- Alt+letter is
 * not a sequence normal typing or editing ever produces. `jumpToLineDigit`
 * covers the 1-9 row as one entry: only extra modifiers on top of the
 * required Alt are configurable, the digit itself always maps to its line
 * index.
 */
export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  {
    id: 'toggleHelp',
    label: 'Show keyboard shortcuts',
    description: 'Opens the shortcuts help overlay.',
    default: { key: '?', alt: true },
    configurable: true,
  },
  {
    id: 'cyclePane',
    label: 'Cycle pane layout',
    description: 'Switches between PDF/form pane arrangements.',
    default: { key: '\\', alt: true },
    configurable: true,
  },
  {
    id: 'openException',
    label: 'Flag exception',
    description: 'Opens the exception dialog for the current bill.',
    default: { key: 'e', alt: true },
    configurable: true,
  },
  {
    id: 'reExtract',
    label: 'Re-extract with Sonnet',
    description: 'Re-runs extraction on the whole document.',
    default: { key: 'r', alt: true },
    configurable: true,
  },
  {
    id: 'openHubStatus',
    label: 'Open hub status',
    description: 'Opens the hub status picker for the current bill.',
    default: { key: 's', alt: true },
    configurable: true,
  },
  {
    id: 'openVendorAutocomplete',
    label: 'Open vendor search',
    description: 'Opens the vendor autocomplete field.',
    default: { key: '/', alt: true },
    configurable: true,
  },
  {
    id: 'focusZone',
    label: 'Focus zone field',
    description: 'Moves focus to the Zone classification field.',
    default: { key: 'z', alt: true },
    configurable: true,
  },
  {
    id: 'focusAdminHead',
    label: 'Focus admin head field',
    description: 'Moves focus to the Admin Head classification field.',
    default: { key: 'h', alt: true },
    configurable: true,
  },
  {
    id: 'jumpToLineDigit',
    label: 'Jump to line item N',
    description: 'Hold the modifier and press 1-9 to jump to that line item.',
    default: { key: '', alt: true },
    configurable: true,
  },
  {
    id: 'nextDocument',
    label: 'Next bill',
    description: 'Goes to the next bill in the queue.',
    default: { key: 'PageDown' },
    configurable: false,
  },
  {
    id: 'prevDocument',
    label: 'Previous bill',
    description: 'Goes to the previous bill in the queue.',
    default: { key: 'PageUp' },
    configurable: false,
  },
  {
    id: 'nextPageImage',
    label: 'Next page image',
    description: 'Advances the PDF viewer by one page.',
    default: { key: 'ArrowRight' },
    configurable: false,
  },
  {
    id: 'prevPageImage',
    label: 'Previous page image',
    description: 'Steps the PDF viewer back one page.',
    default: { key: 'ArrowLeft' },
    configurable: false,
  },
  {
    id: 'saveAndNext',
    label: 'Save and go to next bill',
    description: 'Fires even while a field is focused.',
    default: { key: 'Enter', ctrl: true },
    configurable: false,
  },
]

export type Keymap = Record<ShortcutActionId, ShortcutBinding>

const DEFAULT_KEYMAP: Keymap = SHORTCUT_DEFINITIONS.reduce((acc, def) => {
  acc[def.id] = def.default
  return acc
}, {} as Keymap)

/** Merges a user's stored overrides on top of the defaults. Unknown action
 *  ids in `overrides` (e.g. from a removed action) are silently dropped. An
 *  override missing Alt is dropped too, falling back to the (also
 *  Alt-gated) default -- belt-and-braces alongside saveKeymapPreferences'
 *  own Alt check, in case a row saved under an older, looser rule ever made
 *  it into the database. */
export function resolveKeymap(overrides: Partial<Record<string, ShortcutBinding>>): Keymap {
  const resolved = { ...DEFAULT_KEYMAP }
  for (const def of SHORTCUT_DEFINITIONS) {
    const override = overrides[def.id]
    if (def.configurable && override && typeof override.key === 'string' && override.alt) {
      resolved[def.id] = {
        key: override.key,
        alt: true,
        shift: !!override.shift,
        ctrl: !!override.ctrl,
        meta: !!override.meta,
      }
    }
  }
  return resolved
}

/** True if `event` satisfies `binding`. Letter keys compare case-insensitively
 *  so a binding isn't broken by Shift/Caps Lock state. `ctrl` and `meta` both
 *  represent the platform "primary modifier" slot (Ctrl on Windows, Cmd on
 *  Mac) and are interchangeable, matching the existing Ctrl/Cmd+Enter
 *  convention already used for saveAndNext. */
export function matchesBinding(event: KeyboardEvent, binding: ShortcutBinding): boolean {
  if (!binding.key) return false
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const bindingKey = binding.key.length === 1 ? binding.key.toLowerCase() : binding.key
  if (key !== bindingKey) return false
  if (!!binding.alt !== event.altKey) return false
  if (!!binding.shift !== event.shiftKey) return false
  const primaryModifierPressed = event.ctrlKey || event.metaKey
  const primaryModifierExpected = !!binding.ctrl || !!binding.meta
  return primaryModifierExpected === primaryModifierPressed
}

/** For the jumpToLineDigit action: matches a top-row 1-9 press with the
 *  configured modifier, returning the 1-based line index or null. */
export function matchLineDigit(event: KeyboardEvent, binding: ShortcutBinding): number | null {
  if (!/^[1-9]$/.test(event.key)) return null
  if (!!binding.alt !== event.altKey) return null
  if (!!binding.shift !== event.shiftKey) return null
  const primaryModifierPressed = event.ctrlKey || event.metaKey
  const primaryModifierExpected = !!binding.ctrl || !!binding.meta
  if (primaryModifierExpected !== primaryModifierPressed) return null
  return Number(event.key)
}

export function formatBinding(binding: ShortcutBinding): string {
  const parts: string[] = []
  if (binding.ctrl) parts.push('Ctrl')
  if (binding.meta) parts.push('Cmd')
  if (binding.alt) parts.push('Alt')
  if (binding.shift) parts.push('Shift')
  const keyLabel = binding.key === '' ? '1-9' : binding.key.length === 1 ? binding.key.toUpperCase() : binding.key
  parts.push(keyLabel)
  return parts.join('+')
}

/**
 * Inverted focus guard (plan §2.1): shortcuts fire only when nothing
 * meaningful is focused (activeElement is body/null) or focus sits on an
 * element explicitly opted in via `data-shortcut-safe`. Everything else --
 * buttons, links, labels, inputs, or any element that merely isn't one of
 * the old denylist's four tags -- is now blocked by default. This replaces
 * the old "block only input/textarea/select/combobox" denylist, which let a
 * click that focused a button or label leave shortcuts armed.
 */
export function isSafeShortcutTarget(active: Element | null): boolean {
  if (!active || active === document.body) return true
  return active.hasAttribute('data-shortcut-safe')
}
