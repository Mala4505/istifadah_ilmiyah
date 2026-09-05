/**
 * Global, sticky "period comparison in the shell" for the Reports surface
 * (reporting-blueprint.md §6 fix #9: "Move the event selector and period
 * comparison into the shell. Global, sticky, always visible... If the scope
 * is not visible the numbers are ambiguous." / §8 Phase One). Rendered from
 * app/(app)/reports/layout.tsx so it sits above every Reports screen without
 * touching app/(app)/layout.tsx (which every other screen shares) or
 * app/(app)/reports/page.tsx.
 *
 * A thin server wrapper around two small client pieces:
 *  - EventSwitcher (components/app-shell/event-switcher.tsx, reused as-is)
 *    for admin-or-above -- `setActiveEvent` is admin-gated
 *    (lib/actions/events.ts), so a non-admin viewer gets a read-only badge
 *    instead of a control that would only ever refuse them.
 *  - CompareBasisSelect (new) bound to the `report_compare_basis` cookie via
 *    getCompareBasis()/setCompareBasis() -- a view preference, not gated.
 *
 * `getAllEvents`/`getSelectedEvent` are independent reads (separate
 * queries), and `getCompareBasis()` is a cookie read with no DB dependency
 * -- run together with Promise.all rather than sequentially.
 */
import { getAllEvents, getSelectedEvent } from '@/lib/events/current'
import { getCompareBasis, COMPARE_BASIS_LABELS, type CompareBasis } from '@/lib/reports/compare-basis'
import { isAdminOrAbove, type StaffRole } from '@/lib/auth/roles'
import { EventSwitcher } from '@/components/app-shell/event-switcher'
import { CompareBasisSelect } from '@/components/app-shell/compare-basis-select'

const COMPARE_BASIS_OPTIONS: { value: CompareBasis; label: string }[] = (
  Object.keys(COMPARE_BASIS_LABELS) as CompareBasis[]
).map((key) => ({ value: key, label: COMPARE_BASIS_LABELS[key] }))

export async function ReportsPeriodBar({ role }: { role: StaffRole | null }) {
  const [events, selectedEvent, compareBasis] = await Promise.all([
    getAllEvents(),
    getSelectedEvent(),
    getCompareBasis(),
  ])

  const canSwitchEvent = isAdminOrAbove(role)
  const eventLabel = selectedEvent ? `${selectedEvent.name} (${selectedEvent.hijriYear} H)` : 'No event selected'

  return (
    <div
      className="sticky top-0 z-20 -mx-3 -mt-3 mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-border bg-background px-3 py-3 sm:-mx-6 sm:-mt-6 sm:px-6"
      data-testid="reports-period-bar"
      // Present mode (reporting-blueprint.md §5) hides this bar too -- "no
      // navigation" for a projector — via the generic escape hatch
      // components/reports/present-mode-toggle.tsx's CSS rules provide.
      data-hide-in-present
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Event</span>
        {canSwitchEvent && events.length > 0 ? (
          <EventSwitcher events={events} selectedEventId={selectedEvent?.id ?? null} />
        ) : (
          <span className="rounded-full border border-secondary/40 bg-secondary/10 px-3 py-1 text-sm font-medium text-foreground">
            {eventLabel}
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Compare</span>
        <CompareBasisSelect value={compareBasis} options={COMPARE_BASIS_OPTIONS} />
      </div>
    </div>
  )
}
