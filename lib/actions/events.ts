'use server'

/**
 * Server action backing event creation (Phase 6 Step 1,
 * docs/event-scoping-and-review-fixes-plan.md §1).
 *
 * `createEvent` needs to flip `event.is_current` off the old row and onto
 * the new one, plus seed five membership tables, as a single atomic step
 * against the partial unique index (`event_one_current`,
 * 20260822000005_event_scoping.sql) that allows only one `is_current = true`
 * row. supabase-js/PostgREST has no multi-statement transaction control, so
 * -- exactly like lib/import/run-import.ts's documented transaction-control
 * choice -- this runs over a direct `pg` connection against `DATABASE_URL`
 * (the session pooler, which supports ordinary `BEGIN`/`COMMIT`/`ROLLBACK`),
 * not through supabase-js.
 */

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { Pool } from 'pg'
import { serverEnv } from '@/lib/env.server'
import { logRawError } from '@/lib/friendly-error'
import { requireAdminOrAbove } from '@/lib/export/auth'
import { ACTIVE_EVENT_COOKIE } from '@/lib/events/current'

export type SimpleActionResult = { ok: true } | { ok: false; error: string }

/**
 * Restores event switching (Task 6.2) -- deleted in 2352822 along with the
 * nav-rail switcher that called it, which broke read-only past-event
 * browsing entirely (no way to switch away from the current event). Now
 * called from the minimal Settings -> Events switcher
 * (components/app-shell/event-switcher.tsx) instead of a rail control.
 * Cookie shape mirrors setReviewQueueScope (lib/actions/review.ts:619):
 * same `path`/`maxAge`.
 *
 * Gated admin-or-above -- unlike the original (reachable from the nav rail
 * by any signed-in staff), its only caller now is the admin-gated Settings
 * page, so the action gates itself the same way rather than relying on that
 * page being the sole entry point.
 */
export async function setActiveEvent(eventId: number): Promise<SimpleActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: adminGateMessage(gate.reason) }

  ;(await cookies()).set(ACTIVE_EVENT_COOKIE, String(eventId), { path: '/', maxAge: 60 * 60 * 24 * 365 })
  return { ok: true }
}

export interface CreateEventInput {
  name: string
  hijriYear: string
  startsOn: string | null
  endsOn: string | null
  /** Carried-forward master ids, pre-ticked from the currently-selected
   *  event's membership on the /events form and editable there (doc §1.5).
   *  Budgets are never carried forward -- there is no budgetAllocationIds. */
  departmentIds: number[]
  adminHeadIds: number[]
  zoneIds: number[]
  budgetHeadIds: number[]
  subDepartmentIds: number[]
}

export type CreateEventResult = { ok: true; eventId: number } | { ok: false; error: string }

let pool: Pool | null = null

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: serverEnv.DATABASE_URL, max: 5 })
  }
  return pool
}

function adminGateMessage(reason: 'signed_out' | 'inactive' | 'not_admin'): string {
  switch (reason) {
    case 'signed_out':
      return 'You must be signed in.'
    case 'inactive':
      return 'Your account is pending activation.'
    case 'not_admin':
      return 'Creating a new event is an admin-only action.'
  }
}

/**
 * Admin-gated (doc §1.5's "admin screen"). Inserts the new event row,
 * flips `is_current` off the previous current event and onto this one, and
 * seeds the five membership tables from the ids the caller passes in --
 * all inside one transaction so the partial unique index never sees two
 * `is_current = true` rows at once.
 */
export async function createEvent(input: CreateEventInput): Promise<CreateEventResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: adminGateMessage(gate.reason) }

  const name = input.name.trim()
  const hijriYear = input.hijriYear.trim()
  if (!name) return { ok: false, error: 'Give the event a name.' }
  if (!hijriYear) return { ok: false, error: 'Give the event a Hijri year.' }

  const client = await getPool().connect()
  try {
    await client.query('begin')

    await client.query('update public.event set is_current = false where is_current')

    const inserted = await client.query<{ id: number }>(
      `insert into public.event (name, hijri_year, starts_on, ends_on, is_current)
       values ($1, $2, $3, $4, true)
       returning id`,
      [name, hijriYear, input.startsOn, input.endsOn]
    )
    const eventId = inserted.rows[0]!.id

    if (input.departmentIds.length > 0) {
      await client.query(
        `insert into public.event_department (event_id, department_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [eventId, input.departmentIds]
      )
    }
    if (input.adminHeadIds.length > 0) {
      await client.query(
        `insert into public.event_admin_head (event_id, admin_head_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [eventId, input.adminHeadIds]
      )
    }
    if (input.zoneIds.length > 0) {
      await client.query(
        `insert into public.event_zone (event_id, zone_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [eventId, input.zoneIds]
      )
    }
    if (input.budgetHeadIds.length > 0) {
      await client.query(
        `insert into public.event_budget_head (event_id, budget_head_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [eventId, input.budgetHeadIds]
      )
    }
    if (input.subDepartmentIds.length > 0) {
      await client.query(
        `insert into public.event_sub_department (event_id, sub_department_id)
         select $1, unnest($2::bigint[])
         on conflict do nothing`,
        [eventId, input.subDepartmentIds]
      )
    }

    await client.query('commit')

    // Layout-level: every screen that fetches the selected/current event
    // needs the new row to appear, and the event history list (now a tab on
    // /settings) needs to show it too.
    revalidatePath('/', 'layout')
    revalidatePath('/settings')

    return { ok: true, eventId }
  } catch (error) {
    await client.query('rollback').catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('event_hijri_year_key')) {
      return { ok: false, error: `An event for Hijri year "${hijriYear}" already exists.` }
    }
    return { ok: false, error: logRawError('events.createEvent', message) }
  } finally {
    client.release()
  }
}
