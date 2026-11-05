import { describe, expect, it } from 'vitest'
import {
  END_BEFORE_START,
  NAME_MISSING,
  NAME_TOO_LONG,
  START_EVENT_MISSING,
  createButtonLabel,
  entriesSelectedLabel,
  firstInvalidField,
  validateDetailsStep,
  type NewTagDetails,
} from '@/lib/tags/new-tag-steps'
import { TAG_NAME_MAX } from '@/lib/tags/shared'

const events = [
  { id: 1, hijriYear: '1447', startsOn: '2025-06-01' },
  { id: 2, hijriYear: '1448', startsOn: '2026-06-01' },
  { id: 3, hijriYear: '1449', startsOn: '2027-06-01' },
]

const valid: NewTagDetails = { name: 'Washroom block', startEventId: 2, endEventId: null }

// Anything a person can see must read as plain English.
const RAW = /undefined|null|NaN|invalid|constraint|\{|\}/i

describe('validateDetailsStep', () => {
  it('passes a complete form, with or without an end event', () => {
    expect(validateDetailsStep(valid, events)).toEqual({})
    expect(validateDetailsStep({ ...valid, endEventId: 3 }, events)).toEqual({})
  })

  it('allows the end event to be the same as the start event', () => {
    expect(validateDetailsStep({ ...valid, endEventId: 2 }, events)).toEqual({})
  })

  it('asks for a name, and treats spaces alone as missing', () => {
    expect(validateDetailsStep({ ...valid, name: '' }, events).name).toBe(NAME_MISSING)
    expect(validateDetailsStep({ ...valid, name: '   ' }, events).name).toBe(NAME_MISSING)
  })

  it('refuses a name over the limit', () => {
    expect(validateDetailsStep({ ...valid, name: 'x'.repeat(TAG_NAME_MAX) }, events)).toEqual({})
    expect(validateDetailsStep({ ...valid, name: 'x'.repeat(TAG_NAME_MAX + 1) }, events).name).toBe(NAME_TOO_LONG)
  })

  it('asks for a start event', () => {
    expect(validateDetailsStep({ ...valid, startEventId: null }, events).startEventId).toBe(START_EVENT_MISSING)
  })

  it('needs no departments: a tag is valid with none (they come from linked entries)', () => {
    // The details carry no department field at all, so none can be missing.
    expect(Object.keys(valid).sort()).toEqual(['endEventId', 'name', 'startEventId'])
    expect(validateDetailsStep(valid, events)).toEqual({})
  })

  it('still refuses an end event before the start event', () => {
    expect(validateDetailsStep({ ...valid, startEventId: 3, endEventId: 2 }, events)).toEqual({
      endEventId: END_BEFORE_START,
    })
  })

  it('catches an end event before the start event, by event order not by id', () => {
    expect(validateDetailsStep({ ...valid, startEventId: 3, endEventId: 1 }, events).endEventId).toBe(END_BEFORE_START)
    const shuffled = [
      { id: 7, hijriYear: '1450', startsOn: '2028-06-01' },
      { id: 8, hijriYear: '1448', startsOn: '2026-06-01' },
    ]
    expect(validateDetailsStep({ ...valid, startEventId: 7, endEventId: 8 }, shuffled).endEventId).toBe(END_BEFORE_START)
    expect(validateDetailsStep({ ...valid, startEventId: 8, endEventId: 7 }, shuffled)).toEqual({})
  })

  it('falls back to the Hijri year when events have no start date', () => {
    const undated = [
      { id: 1, hijriYear: '999', startsOn: null },
      { id: 2, hijriYear: '1448', startsOn: null },
    ]
    expect(validateDetailsStep({ ...valid, startEventId: 2, endEventId: 1 }, undated).endEventId).toBe(END_BEFORE_START)
    expect(validateDetailsStep({ ...valid, startEventId: 1, endEventId: 2 }, undated)).toEqual({})
  })

  it('does not report an end-before-start problem when there is no start event yet', () => {
    const errors = validateDetailsStep({ ...valid, startEventId: null, endEventId: 1 }, events)
    expect(errors.endEventId).toBeUndefined()
    expect(errors.startEventId).toBe(START_EVENT_MISSING)
  })

  it('skips the order check for an event it does not know rather than guessing', () => {
    expect(validateDetailsStep({ ...valid, endEventId: 99 }, events)).toEqual({})
  })

  it('reports every problem at once', () => {
    const errors = validateDetailsStep({ name: '', startEventId: null, endEventId: null }, events)
    expect(Object.keys(errors).sort()).toEqual(['name', 'startEventId'])
  })

  it('uses plain English only', () => {
    for (const message of [NAME_MISSING, NAME_TOO_LONG, START_EVENT_MISSING, END_BEFORE_START]) {
      expect(message).not.toMatch(RAW)
    }
  })
})

describe('firstInvalidField', () => {
  it('is null when there are no errors', () => {
    expect(firstInvalidField({})).toBeNull()
  })

  it('follows the order of the form, not the order the errors were added', () => {
    expect(firstInvalidField({ endEventId: 'y', startEventId: 'x' })).toBe('startEventId')
    expect(firstInvalidField({ endEventId: 'y', startEventId: 'x', name: 'z' })).toBe('name')
    expect(firstInvalidField({ endEventId: 'y' })).toBe('endEventId')
  })
})

describe('step 2 labels', () => {
  it('summarises the selection', () => {
    expect(entriesSelectedLabel(0)).toBe('No entries selected')
    expect(entriesSelectedLabel(1)).toBe('1 entry selected')
    expect(entriesSelectedLabel(12)).toBe('12 entries selected')
    expect(entriesSelectedLabel(1500)).toBe('1,500 entries selected')
  })

  it('adapts the create button to the selection', () => {
    expect(createButtonLabel(0)).toBe('Create tag')
    expect(createButtonLabel(1)).toBe('Create tag and link 1 entry')
    expect(createButtonLabel(7)).toBe('Create tag and link 7 entries')
  })
})
