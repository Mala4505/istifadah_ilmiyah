'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logRawError } from '@/lib/friendly-error'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { normalizeVendorName } from '@/lib/normalize'

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

/**
 * Resolves a manually-typed vendor/payee name to a `vendor_id`, creating a
 * new (unconfirmed) vendor if nothing matches yet — the same normalize ->
 * exact match on normalized_name or vendor_alias -> else create rule
 * `vendor_and_alias.sql`'s own comment documents and `lib/import/run-import.ts`'s
 * `resolveVendor` already applies to the Departmental import. A typed entry
 * is the one other place a vendor name enters the system as free text, so it
 * gets the same treatment rather than sitting outside the vendor table
 * forever with only `vendor_raw` set.
 *
 * Runs on the admin (service-role) client, same as
 * `lib/actions/review.ts`'s `learnVendorAliasesFromAttach`/`confirmVendorAlias`
 * and for the same reason: `vendor`/`vendor_alias` deny inserts to
 * `authenticated` entirely (20260808000026_rls_policies.sql) — vendor
 * identity is staff-wide, not department-scoped, so there is no per-caller
 * RLS check to preserve here the way there is for `entries` itself. The
 * entries insert below stays on the session-bound client exactly as before
 * (see this file's header comment) — only this vendor lookup/create step is
 * elevated.
 *
 * Best-effort: any failure here is logged and swallowed, returning null so
 * the caller falls back to the pre-existing behaviour (`vendor_raw` set,
 * `vendor_id` left null) rather than blocking the entry itself over a
 * vendor-lookup problem.
 */
async function resolveOrCreateVendor(rawName: string): Promise<number | null> {
  const trimmed = rawName.trim()
  const normalized = normalizeVendorName(trimmed)
  if (!normalized) return null

  try {
    const admin = createAdminClient()

    const { data: byNormalized, error: byNormalizedError } = await admin
      .from('vendor')
      .select('id')
      .eq('normalized_name', normalized)
      .maybeSingle()
    if (byNormalizedError) throw byNormalizedError
    if (byNormalized) return byNormalized.id as number

    const { data: byAlias, error: byAliasError } = await admin
      .from('vendor_alias')
      .select('vendor_id')
      .eq('raw_name', normalized)
      .maybeSingle()
    if (byAliasError) throw byAliasError
    if (byAlias) return byAlias.vendor_id as number

    const { data: created, error: createError } = await admin
      .from('vendor')
      .insert({ display_name: trimmed, normalized_name: normalized, is_confirmed: false })
      .select('id')
      .single()

    if (createError) {
      // Unique-violation on normalized_name means a concurrent request just
      // created the same vendor — read back what it created rather than
      // failing this one.
      if (createError.code === '23505') {
        const { data: retry } = await admin
          .from('vendor')
          .select('id')
          .eq('normalized_name', normalized)
          .maybeSingle()
        if (retry) return retry.id as number
      }
      throw createError
    }

    const vendorId = created.id as number
    const { error: aliasError } = await admin
      .from('vendor_alias')
      .insert({ vendor_id: vendorId, raw_name: normalized, source: 'manual' })
    // A duplicate alias row (another request winning the same race) is fine —
    // the vendor itself already resolved correctly either way.
    if (aliasError && aliasError.code !== '23505') throw aliasError

    return vendorId
  } catch (err) {
    logRawError('entries.resolveOrCreateVendor', err instanceof Error ? err.message : String(err))
    return null
  }
}

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

  const selectedEvent = await getSelectedEvent()
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

  const vendorId = await resolveOrCreateVendor(fields.vendorName)

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
        vendor_id: vendorId,
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

  const selectedEvent = await getSelectedEvent()
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
