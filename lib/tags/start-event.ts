/**
 * Start-event check for the tag edit form (docs/entry-tags-plan.md, owner decision
 * 2026-11-05): moving a tag's start event LATER than the event of an entry already linked to
 * it is allowed, but the user is warned first and has to confirm. The check runs in the
 * updateTag server action (so it cannot be skipped by a client); the form only shows the
 * warning and re-sends the save with the confirmation flag.
 *
 * Plain module on purpose -- no 'use client' / 'use server' -- because the server action
 * builds the warning and the client form reads its shape. The database is not involved: its
 * trigger only moves start_event back when an entry is linked, never forward.
 */
import { compareEvents, type EventOrderRef } from '@/lib/tags/shared'

/** The warning the server action returns and the form shows. Serialisable. */
export interface StartEventWarning {
  /** Linked entries whose event is before the chosen start event. */
  entryCount: number
  /** Hijri year of the earliest such entry's event. */
  earliestHijriYear: string
  /** Hijri year of the chosen start event. */
  startHijriYear: string
  /** Plain-English sentence for the form. */
  message: string
}

/**
 * Compares the chosen start event with the events of the currently linked entries (one item
 * per entry, voided ones included -- they stay linked). Returns null when no entry is older
 * than the start event, otherwise the warning to show.
 */
export function buildStartEventWarning(
  startEvent: EventOrderRef,
  linkedEntryEvents: readonly EventOrderRef[]
): StartEventWarning | null {
  let entryCount = 0
  let earliest: EventOrderRef | null = null
  for (const event of linkedEntryEvents) {
    if (compareEvents(event, startEvent) >= 0) continue
    entryCount += 1
    if (earliest === null || compareEvents(event, earliest) < 0) earliest = event
  }
  if (entryCount === 0 || earliest === null) return null

  const subject =
    entryCount === 1
      ? `1 linked entry, which is from ${earliest.hijriYear} H`
      : `${entryCount} linked entries, the earliest from ${earliest.hijriYear} H`
  const message =
    `The start event you picked (${startEvent.hijriYear} H) is later than ${subject}. ` +
    'That spending would fall before the tag starts. ' +
    'You can save anyway, or go back and pick an earlier start event.'
  return {
    entryCount,
    earliestHijriYear: earliest.hijriYear,
    startHijriYear: startEvent.hijriYear,
    message,
  }
}
