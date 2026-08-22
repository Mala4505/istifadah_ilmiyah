'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setActiveEvent } from '@/lib/actions/events'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Event } from '@/lib/events/types'

/**
 * Minimal event switcher (Task 6.2, event-scoping-and-review-fixes-plan.md
 * follow-up). The original switcher lived embedded in the nav rail
 * (components/app-shell/nav-rail.tsx) and was deleted wholesale in 2352822
 * ("Simplify nav") along with its only caller -- that left no way to view a
 * past event at all once a second event exists. This does NOT restore it to
 * the rail; that removal was a deliberate, separate nav-simplification
 * decision. Instead it's a small standalone dropdown + button, rendered on
 * the Settings -> Events "Past events" card
 * (app/(app)/settings/page.tsx), the only place left that can flip the
 * `active_event_id` cookie.
 *
 * Selecting an event and pressing Switch calls `setActiveEvent` (admin-gated
 * server action, lib/actions/events.ts) then refreshes so every
 * server-rendered screen re-reads the new selection -- same
 * select-then-refresh shape as the pre-deletion version.
 */
export function EventSwitcher({
  events,
  selectedEventId,
}: {
  events: Event[]
  selectedEventId: number | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState(selectedEventId !== null ? String(selectedEventId) : '')

  if (events.length === 0) return null

  const parsedValue = Number(value)
  const isUnchanged = Number.isFinite(parsedValue) && parsedValue === selectedEventId

  function handleSwitch() {
    if (!Number.isFinite(parsedValue) || isUnchanged) return
    startTransition(async () => {
      const result = await setActiveEvent(parsedValue)
      if (!result.ok) {
        toastError(result.error, { context: 'event-switcher' })
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={value} onValueChange={setValue} disabled={isPending}>
        <SelectTrigger className="w-64" aria-label="Select an event to view">
          <SelectValue placeholder="Select an event" />
        </SelectTrigger>
        <SelectContent>
          {events.map((event) => (
            <SelectItem key={event.id} value={String(event.id)}>
              {event.name} ({event.hijriYear} H){event.isCurrent ? ' — current' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button type="button" variant="outline" size="sm" disabled={isPending || isUnchanged} onClick={handleSwitch}>
        {isPending ? 'Switching…' : 'Switch'}
      </Button>
    </div>
  )
}
