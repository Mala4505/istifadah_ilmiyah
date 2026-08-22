/**
 * Shape of a `public.event` row (Phase 6 Step 1,
 * docs/event-scoping-and-review-fixes-plan.md §1.2). One event per Hijri
 * year -- master data (department/admin_head/zone/budget_head) is shared
 * across events; only membership (`event_department` etc.) is per-event.
 */
export interface Event {
  id: number
  name: string
  hijriYear: string
  startsOn: string | null
  endsOn: string | null
  isCurrent: boolean
  createdAt: string
}
