'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { logRawError } from '@/lib/friendly-error'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'

// Phase 6 Step 2 (docs/event-scoping-and-review-fixes-plan.md §1.6): past
// events are browsable read-only. Every mutation in this file is gated on
// the currently-selected event still being the current one before it
// touches the database.
const EVENT_READONLY_ERROR = 'This event is read-only — switch to the current event to make changes.'

/**
 * Typed entries — the path a department-scoped account uses instead of an
 * import (confirmed 2026-08-19). Everything here runs on the SESSION-bound
 * client, never the admin client: `entries_insert`
 * (20260819000002_manual_entries.sql) is the real gate, so a dept user
 * aiming at somebody else's department is stopped by the database rather
 * than by a check in this file that could drift out of step with it.
 *
 * The department is resolved from the caller's own `staff_profile` rather
 * than taken from the form whenever that profile is scoped to one — a scoped
 * user has exactly one legitimate answer, and reading it server-side means
 * the client cannot propose a different one even before RLS sees it.
 */

type CreateResult = { ok: true; entryId: number; ubblNumber: string } | { ok: false; error: string }
type UpdateResult = { ok: true } | { ok: false; error: string }

const createManualEntrySchema = z.object({
  departmentId: z.number().int().positive().nullable(),
  type: z.enum(['invoice', 'reimbursement', 'advance_payment']),
  vendorName: z.string().trim().min(1, 'Enter the vendor or payee name.').max(300),
  invoiceNumber: z.string().trim().max(100).optional().default(''),
  date: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the bill date.')
    .optional()
    .or(z.literal('')),
  amount: z
    .number({ invalid_type_error: 'Enter the amount.' })
    .finite()
    .positive('The amount must be more than zero.')
    .max(99_999_999_999.99, 'That amount is too large.'),
  budgetHeadId: z.number().int().positive().nullable(),
  remark: z.string().trim().max(2000).optional().default(''),
})

export type CreateManualEntryInput = z.input<typeof createManualEntrySchema>

/**
 * How many times to retry when the generated number is already taken. The
 * sequence makes a natural collision impossible; the only way one happens is
 * if somebody typed a number into the reserved `M-` range by hand, so a
 * couple of retries walks past it rather than failing the whole save.
 */
const NUMBER_COLLISION_RETRIES = 3

export async function createManualEntry(input: CreateManualEntryInput): Promise<CreateResult> {
  const parsed = createManualEntrySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }
  const fields = parsed.data

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'You need to sign in to add an entry.' }

  const selectedEvent = await getSelectedEvent(supabase)
  if (!selectedEvent || !isEventMutable(selectedEvent)) {
    return { ok: false, error: EVENT_READONLY_ERROR }
  }

  const { data: profile, error: profileError } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', user.id)
    .maybeSingle()

  if (profileError) {
    return { ok: false, error: logRawError('entries.createManualEntry:profile', profileError.message) }
  }
  if (!profile || !profile.is_active) {
    return { ok: false, error: 'Your account is not active yet. Ask an administrator to activate it.' }
  }

  // A dept profile files against one of its own department(s) — resolved
  // automatically when it has exactly one, otherwise the form has to say
  // which. An admin/superadmin profile has to say which one regardless —
  // there is no sensible default across every department, and a null
  // department would be visible to everybody (the `department_id is not
  // null` half of the insert policy rejects it anyway).
  let departmentId: number | null
  if (profile.role === 'dept') {
    const { data: depts, error: deptsError } = await supabase
      .from('staff_department')
      .select('department_id')
      .eq('staff_id', user.id)
    if (deptsError) {
      return { ok: false, error: logRawError('entries.createManualEntry:departments', deptsError.message) }
    }
    const ids = (depts ?? []).map((d) => d.department_id as number)
    if (ids.length === 1) {
      departmentId = ids[0]!
    } else if (fields.departmentId !== null && ids.includes(fields.departmentId)) {
      departmentId = fields.departmentId
    } else {
      return { ok: false, error: 'Choose which of your departments this entry belongs to.' }
    }
  } else {
    // admin / superadmin: still take it from the form, no sensible default across every department.
    departmentId = fields.departmentId
  }
  if (departmentId === null || departmentId === undefined) {
    return { ok: false, error: 'Choose which department this entry belongs to.' }
  }

  for (let attempt = 0; attempt < NUMBER_COLLISION_RETRIES; attempt += 1) {
    const { data: generatedNumber, error: numberError } = await supabase.rpc('next_manual_ubbl_number')
    if (numberError || typeof generatedNumber !== 'string') {
      return {
        ok: false,
        error: logRawError(
          'entries.createManualEntry:number',
          numberError?.message ?? 'next_manual_ubbl_number returned no value'
        ),
      }
    }

    const { data: inserted, error: insertError } = await supabase
      .from('entries')
      .insert({
        ubbl_number: generatedNumber,
        source: 'manual',
        department_id: departmentId,
        type: fields.type,
        vendor_raw: fields.vendorName,
        invoice_number: fields.invoiceNumber || null,
        date: fields.date || null,
        amount: fields.amount,
        budget_head_id: fields.budgetHeadId,
        remark: fields.remark || null,
        event_id: selectedEvent.id,
      })
      .select('id, ubbl_number')
      .single()

    if (!insertError && inserted) {
      revalidatePath('/entries')
      revalidatePath('/')
      return { ok: true, entryId: inserted.id as number, ubblNumber: inserted.ubbl_number as string }
    }

    // Only a number clash is worth another attempt — anything else (a
    // permission failure, a bad value) will fail identically next time.
    const isNumberClash =
      insertError?.message.includes('entries_ubbl_number_key') ?? false
    if (!isNumberClash) {
      return { ok: false, error: logRawError('entries.createManualEntry:insert', insertError?.message ?? 'insert returned no row') }
    }
  }

  return {
    ok: false,
    error: 'Could not assign an entry number after several tries. Try again, or contact an admin.',
  }
}

const realUbblNumberSchema = z
  .string()
  .trim()
  .min(1, 'Enter the UBBL number from the paperwork.')
  .max(60, 'That number is too long.')
  .refine((value) => !/^M-\d{6}$/i.test(value), {
    message: 'That is a provisional number. Enter the real UBBL number instead.',
  })

/**
 * Swaps a typed entry's provisional `M-` number for the real UBBL number once
 * the paperwork arrives — the second half of the confirmed 2026-08-19 flow.
 * An ordinary UPDATE, so `entries_update` RLS and the change-log trigger
 * (20260808000017) apply unchanged: the swap lands in `entry_change_log` with
 * both the old and new number, which is what makes it auditable rather than a
 * silent rewrite of an identifier other systems may already have seen.
 *
 * `entries_update` now requires `is_admin_or_above()` (20260819000003), so a
 * dept user's update attempt matches zero rows and falls into the
 * `!data || data.length === 0` branch below — even for their OWN
 * department's entry, not just another department's. Only admin/superadmin
 * can complete this swap from here on.
 */
export async function replaceProvisionalUbblNumber(input: {
  entryId: number
  ubblNumber: string
}): Promise<UpdateResult> {
  if (!Number.isInteger(input.entryId) || input.entryId <= 0) {
    return { ok: false, error: 'Invalid entry.' }
  }
  const parsed = realUbblNumberSchema.safeParse(input.ubblNumber)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }

  const supabase = await createClient()

  const selectedEvent = await getSelectedEvent(supabase)
  if (!isEventMutable(selectedEvent)) {
    return { ok: false, error: EVENT_READONLY_ERROR }
  }

  const { data, error } = await supabase
    .from('entries')
    .update({ ubbl_number: parsed.data })
    .eq('id', input.entryId)
    .select('id')

  if (error) {
    return { ok: false, error: logRawError('entries.replaceProvisionalUbblNumber', error.message) }
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      error:
        'Nothing was updated. This entry may be outside your department, or your account may be view-only.',
    }
  }

  revalidatePath(`/entries/${input.entryId}`)
  revalidatePath('/entries')
  return { ok: true }
}
