import { TAG_NAME_MAX, compareEvents, type EventOrderRef } from '@/lib/tags/shared'

/**
 * The logic behind the two-step "New tag" dialog (components/tags/tag-form-dialog.tsx): what
 * step 1 ("Details") checks before Next, and the labels step 2 shows. Plain module -- no
 * 'use client' / 'use server' -- so the dialog and the unit tests share it, and it can be
 * imported from anywhere without the production RSC crash that a value import from a client
 * module causes.
 *
 * Departments are not asked for here: a tag's departments come from the entries linked to it
 * (a database trigger adds each entry's department / sub-department), or a super-admin adds
 * them by hand on the tag page. A new tag may have none.
 */

export type NewTagStep = 'details' | 'entries'

/** The step-1 fields that can be wrong, in the order they appear on screen. */
export type DetailsField = 'name' | 'startEventId' | 'endEventId'

export const DETAILS_FIELD_ORDER: readonly DetailsField[] = ['name', 'startEventId', 'endEventId']

export type DetailsErrors = Partial<Record<DetailsField, string>>

export interface NewTagDetails {
  name: string
  startEventId: number | null
  endEventId: number | null
}

export const NAME_MISSING = 'Give the tag a name.'
export const NAME_TOO_LONG = 'The tag name is too long. Shorten it a little.'
export const START_EVENT_MISSING = 'Pick the start event.'
export const END_BEFORE_START = 'The end event cannot be before the start event.'

/**
 * The problems with step 1, one plain-English sentence per field; an empty object means the
 * person can move on. `events` is only used to compare the start and end events -- if either
 * is not in the list the order check is skipped rather than guessed at.
 */
export function validateDetailsStep(details: NewTagDetails, events: readonly EventOrderRef[]): DetailsErrors {
  const errors: DetailsErrors = {}

  const name = details.name.trim()
  if (name === '') errors.name = NAME_MISSING
  else if (name.length > TAG_NAME_MAX) errors.name = NAME_TOO_LONG

  if (details.startEventId === null) errors.startEventId = START_EVENT_MISSING

  if (details.startEventId !== null && details.endEventId !== null) {
    const start = events.find((e) => e.id === details.startEventId)
    const end = events.find((e) => e.id === details.endEventId)
    if (start && end && compareEvents(end, start) < 0) errors.endEventId = END_BEFORE_START
  }

  return errors
}

/** The first field with an error, in on-screen order, so focus can move to it. Null = none. */
export function firstInvalidField(errors: DetailsErrors): DetailsField | null {
  return DETAILS_FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null
}

/** Step 2's live summary line: "No entries selected", "1 entry selected", "12 entries selected". */
export function entriesSelectedLabel(count: number): string {
  if (count === 0) return 'No entries selected'
  return `${count.toLocaleString('en-IN')} ${count === 1 ? 'entry' : 'entries'} selected`
}

/** The primary button on step 2: plain "Create tag" until some entries are chosen. */
export function createButtonLabel(entryCount: number): string {
  if (entryCount <= 0) return 'Create tag'
  return `Create tag and link ${entryCount.toLocaleString('en-IN')} ${entryCount === 1 ? 'entry' : 'entries'}`
}
