/**
 * Unit tests for lib/shortcuts/config.ts (Hub screen certification, Wave 2
 * item 2.3 — "The help binding can never fire").
 *
 * The regression: `toggleHelp` defaults to `{ key: '?', alt: true }` with no
 * `shift`, but typing '?' forces `event.shiftKey` true on most layouts, so the
 * old `!!binding.shift !== event.shiftKey` check rejected it unconditionally.
 * matchesBinding now skips the Shift comparison for single-character
 * punctuation keys, whose identity ('?', '\\', '/') already disambiguates them.
 */

import { describe, it, expect } from 'vitest'
import {
  matchesBinding,
  matchLineDigit,
  resolveKeymap,
  formatBinding,
  type ShortcutBinding,
} from '@/lib/shortcuts/config'

function fakeEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  } as unknown as KeyboardEvent
}

describe('matchesBinding', () => {
  it('matches an alpha key case-insensitively', () => {
    const binding: ShortcutBinding = { key: 'e', alt: true }
    expect(matchesBinding(fakeEvent({ key: 'E', altKey: true }), binding)).toBe(true)
    expect(matchesBinding(fakeEvent({ key: 'e', altKey: true }), binding)).toBe(true)
  })

  it('returns false when Alt is required but not pressed', () => {
    const binding: ShortcutBinding = { key: 'e', alt: true }
    expect(matchesBinding(fakeEvent({ key: 'e', altKey: false }), binding)).toBe(false)
  })

  it('treats Ctrl and Meta as interchangeable for the primary-modifier slot', () => {
    const binding: ShortcutBinding = { key: 'Enter', ctrl: true }
    expect(matchesBinding(fakeEvent({ key: 'Enter', ctrlKey: true }), binding)).toBe(true)
    expect(matchesBinding(fakeEvent({ key: 'Enter', metaKey: true }), binding)).toBe(true)

    const metaBinding: ShortcutBinding = { key: 'Enter', meta: true }
    expect(matchesBinding(fakeEvent({ key: 'Enter', ctrlKey: true }), metaBinding)).toBe(true)
    expect(matchesBinding(fakeEvent({ key: 'Enter', metaKey: true }), metaBinding)).toBe(true)
  })

  it('matches { key: "?", alt: true } even though the event has shiftKey true (the 2.3 regression)', () => {
    const binding: ShortcutBinding = { key: '?', alt: true }
    expect(
      matchesBinding(fakeEvent({ key: '?', altKey: true, shiftKey: true }), binding),
    ).toBe(true)
  })

  it('does not match a { key: "/", alt: true } binding against that same "?" event', () => {
    const binding: ShortcutBinding = { key: '/', alt: true }
    expect(
      matchesBinding(fakeEvent({ key: '?', altKey: true, shiftKey: true }), binding),
    ).toBe(false)
  })
})

describe('matchLineDigit', () => {
  const binding: ShortcutBinding = { key: '', alt: true }

  it('returns the digit for Alt+3', () => {
    expect(matchLineDigit(fakeEvent({ key: '3', altKey: true }), binding)).toBe(3)
  })

  it('returns null for a bare 3', () => {
    expect(matchLineDigit(fakeEvent({ key: '3', altKey: false }), binding)).toBeNull()
  })

  it('returns null for a non-digit', () => {
    expect(matchLineDigit(fakeEvent({ key: 'a', altKey: true }), binding)).toBeNull()
  })
})

describe('resolveKeymap', () => {
  it('drops an override that is missing alt, falling back to the default', () => {
    const resolved = resolveKeymap({ openException: { key: 'x' } as ShortcutBinding })
    expect(resolved.openException).toEqual({ key: 'e', alt: true })
  })

  it('ignores an unknown action id', () => {
    const resolved = resolveKeymap({ notARealAction: { key: 'x', alt: true } })
    expect(resolved).not.toHaveProperty('notARealAction')
    expect(resolved.openException).toEqual({ key: 'e', alt: true })
  })

  it('applies a valid Alt override', () => {
    const resolved = resolveKeymap({ openException: { key: 'x', alt: true } })
    expect(resolved.openException).toEqual({
      key: 'x',
      alt: true,
      shift: false,
      ctrl: false,
      meta: false,
    })
  })
})

describe('formatBinding', () => {
  it('formats { key: "e", alt: true } as "Alt+E"', () => {
    expect(formatBinding({ key: 'e', alt: true })).toBe('Alt+E')
  })

  it('formats { key: "", alt: true } as "Alt+1-9"', () => {
    expect(formatBinding({ key: '', alt: true })).toBe('Alt+1-9')
  })
})
