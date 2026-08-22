'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, ChevronsUpDown, CalendarRange } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { setActiveEvent } from '@/lib/actions/events'
import { toastError } from '@/components/ui/error-toast'
import type { Event } from '@/lib/events/types'

/**
 * Event switcher (Phase 6 Step 1, doc §1.3 "A switcher in the app-shell
 * header"). Same Popover primitive as nav-rail.tsx's account popover, wired
 * in as its sibling in the rail footer. Selecting an event sets the
 * `active_event_id` cookie via `setActiveEvent` then refreshes so every
 * server-rendered screen re-reads the new selection.
 */
export function EventSwitcher({
  events,
  selectedEvent,
  collapsed,
}: {
  events: Event[]
  selectedEvent: Event | null
  collapsed: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function handleSelect(eventId: number) {
    if (eventId === selectedEvent?.id) return
    startTransition(async () => {
      const result = await setActiveEvent(eventId)
      if (!result.ok) {
        toastError(result.error, { context: 'event-switcher' })
        return
      }
      router.refresh()
    })
  }

  if (events.length === 0) return null

  const label = selectedEvent ? selectedEvent.name : 'No event selected'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}, switch event`}
          disabled={isPending}
          className={cn(
            'flex w-full items-center rounded-md transition-colors hover:bg-secondary/60 disabled:opacity-60',
            collapsed ? 'justify-center p-1.5' : 'gap-2.5 p-1.5'
          )}
        >
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
            aria-hidden="true"
          >
            <CalendarRange className="h-4 w-4" strokeWidth={1.75} />
          </div>
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium leading-tight text-foreground">
                  {selectedEvent ? `${selectedEvent.hijriYear} H` : label}
                </p>
                {selectedEvent && !selectedEvent.isCurrent && (
                  <p className="truncate text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
                    Past event — read only
                  </p>
                )}
              </div>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align={collapsed ? 'center' : 'start'} sideOffset={8} className="w-64 p-2">
        <div className="px-1.5 py-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Event</p>
        </div>
        <div className="my-1.5 border-t border-border" />
        <ul className="flex flex-col gap-0.5">
          {events.map((event) => {
            const isSelected = event.id === selectedEvent?.id
            return (
              <li key={event.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(event.id)}
                  disabled={isPending}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-secondary/60 disabled:opacity-60',
                    isSelected && 'font-medium'
                  )}
                >
                  <span className="min-w-0 truncate">
                    {event.name}
                    {!event.isCurrent && (
                      <span className="ml-1.5 text-[11px] font-normal uppercase tracking-wide text-muted-foreground">
                        past
                      </span>
                    )}
                  </span>
                  {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2} />}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
