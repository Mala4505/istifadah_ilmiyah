import { describe, expect, it } from 'vitest'
import {
  INVALID_TAG_REQUEST,
  TAG_ENTRIES_PER_CALL,
  TAG_ENTRY_LIMIT_MESSAGE,
  TAG_SCOPE_LIMIT_MESSAGE,
  TAG_SCOPE_PICKS_MAX,
  duplicateTagMessage,
  entryCountError,
  newTagInputError,
} from '@/lib/tags/limits'

// Anything a person can see must read as plain English: no zod wording, no constraint names.
const RAW = /array must|element\(s\)|too_big|too_small|violates|constraint|_pkey|_key|\{|\}/i

describe('entryCountError', () => {
  it('accepts 1 up to the shared limit', () => {
    expect(entryCountError(1)).toBeNull()
    expect(entryCountError(TAG_ENTRIES_PER_CALL)).toBeNull()
  })
  it('asks for at least one entry when one is required', () => {
    expect(entryCountError(0)).toBe('Pick at least one entry.')
    expect(entryCountError(0, { required: false })).toBeNull()
  })
  it('says how many are allowed when there are too many, in plain English', () => {
    const message = entryCountError(TAG_ENTRIES_PER_CALL + 1)
    expect(message).toBe(TAG_ENTRY_LIMIT_MESSAGE)
    expect(message).toContain('1,000')
    expect(message).not.toMatch(RAW)
    expect(entryCountError(TAG_ENTRIES_PER_CALL + 1, { required: false })).toBe(TAG_ENTRY_LIMIT_MESSAGE)
  })
})

describe('newTagInputError', () => {
  const ok = { name: 'Washroom block', scopeCount: 1, entryCount: 0, nameMax: 200 }
  it('passes a valid request, with or without entries', () => {
    expect(newTagInputError(ok)).toBeNull()
    expect(newTagInputError({ ...ok, entryCount: TAG_ENTRIES_PER_CALL })).toBeNull()
  })
  it('names the first problem in plain English', () => {
    expect(newTagInputError({ ...ok, name: '   ' })).toBe('Give the tag a name.')
    expect(newTagInputError({ ...ok, name: 'x'.repeat(201) })).toBe('The tag name is too long.')
    expect(newTagInputError({ ...ok, scopeCount: 0 })).toBe('Pick at least one department.')
    expect(newTagInputError({ ...ok, scopeCount: TAG_SCOPE_PICKS_MAX + 1 })).toBe(TAG_SCOPE_LIMIT_MESSAGE)
    expect(newTagInputError({ ...ok, entryCount: TAG_ENTRIES_PER_CALL + 1 })).toBe(TAG_ENTRY_LIMIT_MESSAGE)
  })
  it('never produces raw validation text', () => {
    for (const message of [TAG_ENTRY_LIMIT_MESSAGE, TAG_SCOPE_LIMIT_MESSAGE, INVALID_TAG_REQUEST]) {
      expect(message).not.toMatch(RAW)
    }
  })
})

describe('duplicateTagMessage', () => {
  it('tells a duplicate department apart from a duplicate entry link', () => {
    expect(
      duplicateTagMessage(
        'duplicate key value violates unique constraint "tag_scope_tag_department_sub_department_key"'
      )
    ).toBe('That department is already on this tag.')
    expect(duplicateTagMessage('duplicate key value violates unique constraint "tag_entry_pkey"')).toBe(
      'That entry is already linked to this tag.'
    )
  })
  it('has a neutral answer for any other duplicate', () => {
    expect(duplicateTagMessage('duplicate key value violates unique constraint "tag_event_note_pkey"')).toBe(
      'That is already on this tag.'
    )
  })
  it('is null for errors that are not duplicates', () => {
    expect(duplicateTagMessage('permission denied for table tag')).toBeNull()
  })
})
