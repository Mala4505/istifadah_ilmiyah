'use server'

import { revalidatePath, revalidateTag } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireSuperadmin } from '@/lib/export/auth'
import { itsNumberSchema, itsNumberToLoginEmail } from '@/lib/auth/its'
import { logRawError } from '@/lib/friendly-error'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { REFERENCE_DATA_TAGS } from '@/lib/cache/reference-data'

type ActionResult = { ok: true } | { ok: false; error: string }

const createStaffUserSchema = z.object({
  itsNumber: itsNumberSchema,
  displayName: z.string().trim().min(1, 'Name is required.'),
  contactEmail: z.union([z.string().trim().email('Enter a valid email address.'), z.literal('')]),
  role: z.enum(['superadmin', 'admin', 'dept']),
  departmentIds: z.array(z.number().int().positive()),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
})

/**
 * Superadmin-provisioned account creation — the only way a staff account is
 * created now (§4.4c: nobody self-serves into access). Writes through the
 * service-role admin client, which bypasses RLS entirely, so the superadmin
 * gate here is the only thing standing in front of it — checked with the
 * session-bound client FIRST, same pattern as app/api/import/route.ts.
 * ITS number becomes Supabase Auth's internal login identifier
 * (lib/auth/its.ts); the account lands active immediately, since a
 * superadmin explicitly provisioning it is a stronger signal than the
 * self-signup trigger's inactive-by-default fallback (20260810000001).
 *
 * Creating staff accounts is a superadmin-only action.
 */
export async function createStaffUser(input: {
  itsNumber: string
  displayName: string
  contactEmail: string
  role: 'superadmin' | 'admin' | 'dept'
  departmentIds: number[]
  password: string
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) {
    return { ok: false, error: 'Creating staff accounts is a superadmin-only action.' }
  }

  const parsed = createStaffUserSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }
  const { itsNumber, displayName, contactEmail, role, departmentIds, password } = parsed.data

  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('staff_profile')
    .select('id')
    .eq('its_number', itsNumber)
    .maybeSingle()
  if (existing) {
    return { ok: false, error: `ITS number ${itsNumber} is already registered.` }
  }

  const { error: createError } = await admin.auth.admin.createUser({
    email: itsNumberToLoginEmail(itsNumber),
    password,
    email_confirm: true,
    user_metadata: {
      its_number: itsNumber,
      full_name: displayName,
      role,
      department_ids: departmentIds,
      is_active: true,
      contact_email: contactEmail || null,
    },
  })

  // The its_number unique index (20260810000001) is the backstop against a
  // race with the pre-check above: a losing concurrent insert fails the
  // handle_new_user trigger with a unique_violation, which createUser
  // surfaces as an error here rather than silently landing a duplicate.
  if (createError) return { ok: false, error: logRawError('admin.createStaffUser', createError.message) }

  revalidatePath('/admin')
  return { ok: true }
}

const resetStaffPasswordSchema = z.object({
  id: z.string().uuid(),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
})

/**
 * Sets a new password for an existing staff account (perf-ux-audit-checklist
 * §4.2: there was previously no in-app lever for this at all -- an admin
 * could set a password at account creation via createStaffUser, but nothing
 * updated one afterward, and createStaffUser itself rejects an
 * already-registered ITS number, so "recreate the account" wasn't a
 * workaround either). Same posture as createStaffUser: superadmin gate
 * checked first, then the service-role admin client, since
 * `auth.admin.updateUserById` bypasses RLS entirely and there is no
 * database-level backstop for it.
 *
 * Resetting a staff password is a superadmin-only action.
 */
export async function resetStaffPassword(input: { id: string; password: string }): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) {
    return { ok: false, error: 'Resetting a staff password is a superadmin-only action.' }
  }

  const parsed = resetStaffPasswordSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }

  const admin = createAdminClient()

  const { error } = await admin.auth.admin.updateUserById(parsed.data.id, { password: parsed.data.password })
  if (error) return { ok: false, error: logRawError('admin.resetStaffPassword', error.message) }

  return { ok: true }
}

/**
 * Updates a staff member's role, department assignment(s), or active flag
 * (§4.4c — "Manage users, roles, department assignment" is superadmin-only).
 * RLS (staff_profile_update, staff_department_insert/update/delete —
 * 20260819000003) already pins those writes to `is_superadmin()`, but this
 * action also has to sync the separate `staff_department` junction table,
 * which RLS on `staff_profile` alone doesn't protect end-to-end from the
 * app's perspective — so an explicit gate is added here, same pattern as
 * `createStaffUser`.
 */
export async function updateStaffProfile(input: {
  id: string
  role: 'superadmin' | 'admin' | 'dept'
  departmentIds: number[]
  isActive: boolean
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) {
    return { ok: false, error: 'Managing staff accounts is a superadmin-only action.' }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from('staff_profile')
    .update({ role: input.role, is_active: input.isActive })
    .eq('id', input.id)

  if (error) return { ok: false, error: logRawError('admin.updateStaffProfile:profile', error.message) }

  // Document assignment ("dividing the document inbox", 2026-08-29): a
  // deactivated account can't remain an assignee, so drop its
  // source_document_assignee rows — any document left with no assignees falls
  // back to the shared pool. The junction table has no DELETE grant for
  // `authenticated` (writes normally go through the
  // set_source_document_assignees RPC), so this clean-up runs on the
  // service-role client, safe here after the requireSuperadmin() gate above —
  // same posture as createStaffUser.
  if (!input.isActive) {
    const { error: assigneeError } = await createAdminClient()
      .from('source_document_assignee')
      .delete()
      .eq('staff_id', input.id)

    if (assigneeError) {
      return { ok: false, error: logRawError('admin.updateStaffProfile:assignees', assigneeError.message) }
    }
  }

  const { error: deleteError } = await supabase
    .from('staff_department')
    .delete()
    .eq('staff_id', input.id)

  if (deleteError) {
    return { ok: false, error: logRawError('admin.updateStaffProfile:departments:clear', deleteError.message) }
  }

  if (input.role === 'dept' && input.departmentIds.length > 0) {
    const { error: insertError } = await supabase
      .from('staff_department')
      .insert(input.departmentIds.map((departmentId) => ({ staff_id: input.id, department_id: departmentId })))

    if (insertError) {
      return { ok: false, error: logRawError('admin.updateStaffProfile:departments:insert', insertError.message) }
    }
  }

  revalidatePath('/admin')
  return { ok: true }
}

/**
 * Maps a source budget head onto a Hub head — the deferred merge point
 * budget_head.head_id exists for (§3.1). Admin-only per
 * budget_head_update_admin (20260808000026).
 */
export async function updateBudgetHeadMapping(input: {
  budgetHeadId: number
  headId: number | null
}): Promise<ActionResult> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('budget_head')
    .update({ head_id: input.headId })
    .eq('id', input.budgetHeadId)

  if (error) return { ok: false, error: logRawError('admin.updateBudgetHeadMapping', error.message) }

  revalidatePath('/admin')
  revalidateTag(REFERENCE_DATA_TAGS.budgetHead)
  return { ok: true }
}

/**
 * Merges one vendor identity into another (§3.2 — never automatic, always a
 * human, admin decision, because it affects payment routing). The target
 * must itself be unclustered: merging into an already-merged vendor would
 * build a chain instead of the flat root-plus-aliases shape
 * `vendor.cluster_group_id` is meant to hold.
 */
export async function mergeVendor(input: {
  vendorId: number
  targetVendorId: number
}): Promise<ActionResult> {
  if (input.vendorId === input.targetVendorId) {
    return { ok: false, error: 'A vendor cannot be merged into itself.' }
  }

  const supabase = await createClient()

  const { data: target, error: targetError } = await supabase
    .from('vendor')
    .select('id, cluster_group_id')
    .eq('id', input.targetVendorId)
    .single()

  if (targetError || !target) {
    return { ok: false, error: 'Target vendor not found.' }
  }
  if (target.cluster_group_id !== null) {
    return { ok: false, error: 'Merge into the root vendor, not one that is itself already merged.' }
  }

  const { error } = await supabase
    .from('vendor')
    .update({ cluster_group_id: input.targetVendorId, is_confirmed: true })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.mergeVendor', error.message) }

  revalidatePath('/admin')
  return { ok: true }
}

/** Undoes a vendor merge, restoring it as an independent identity. */
export async function unmergeVendor(input: { vendorId: number }): Promise<ActionResult> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ cluster_group_id: null })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.unmergeVendor', error.message) }

  revalidatePath('/admin')
  return { ok: true }
}

const updateSubDepartmentBudgetSchema = z.object({
  subDepartmentId: z.number().int().positive(),
  budgetAmount: z.number().nonnegative('Budget amount cannot be negative.').nullable(),
})

/**
 * Manually sets a sub-department's budget from the Settings page, independent
 * of the periodic sub-department-budget import
 * (lib/import/run-sub-department-budget-import.ts). Superadmin-only by
 * request -- deliberately narrower than the RLS update policy on
 * `sub_department_budget_allocation` (`is_reviewer_or_admin()`, i.e.
 * admin-or-above), same pattern as createStaffUser: an app-level gate
 * stricter than the database's own floor.
 *
 * `sub_department_budget_allocation` is an append-only snapshot table with a
 * not-null `import_batch_id` FK and NO insert policy for `authenticated` at
 * all (rows are meant to come from the import pipeline running as
 * service_role) -- so, like createStaffUser, this writes through the
 * service-role admin client after the gate above, inserting one lightweight
 * `import_batch` row (mirroring the real importer's `source_system`) to
 * satisfy the FK, then one new allocation row dated today. That row becomes
 * "latest" for this (sub_department, event) pair by the same
 * (as_of desc, id desc) ordering a real import relies on.
 *
 * Restricted to the current event (`isEventMutable`) -- past events are
 * browsable read-only (docs/event-scoping-and-review-fixes-plan.md §1.6),
 * and a manual budget edit is exactly the kind of write that must not land
 * against closed history.
 */
export async function updateSubDepartmentBudget(input: {
  subDepartmentId: number
  budgetAmount: number | null
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) {
    return { ok: false, error: 'Editing budgets is a superadmin-only action.' }
  }

  const parsed = updateSubDepartmentBudgetSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }

  const supabase = await createClient()
  const selectedEvent = await getSelectedEvent(supabase)
  if (!selectedEvent) {
    return { ok: false, error: 'No event is configured yet. Contact an admin.' }
  }
  if (!isEventMutable(selectedEvent)) {
    return {
      ok: false,
      error: 'The selected event is closed to editing -- switch to the current event before editing budgets.',
    }
  }

  const admin = createAdminClient()

  const { data: batch, error: batchError } = await admin
    .from('import_batch')
    .insert({
      source_system: 'sub_department_budget',
      source_filename: 'manual edit (settings)',
      file_hash_sha256: 'manual',
      mode: 'commit',
      imported_by: gate.staff.userId,
      event_id: selectedEvent.id,
      status: 'completed',
      row_count: 1,
      summary_jsonb: { manual_edit: 1 },
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (batchError || !batch) {
    return {
      ok: false,
      error: logRawError('admin.updateSubDepartmentBudget:batch', batchError?.message ?? 'insert failed'),
    }
  }

  const { error } = await admin.from('sub_department_budget_allocation').insert({
    sub_department_id: parsed.data.subDepartmentId,
    event_id: selectedEvent.id,
    import_batch_id: batch.id,
    as_of: new Date().toISOString().slice(0, 10),
    budget_amount: parsed.data.budgetAmount,
  })

  if (error) return { ok: false, error: logRawError('admin.updateSubDepartmentBudget', error.message) }

  revalidatePath('/settings')
  return { ok: true }
}

/** Marks a vendor identity as human-reviewed, independent of merging (§3.2). */
export async function setVendorConfirmed(input: {
  vendorId: number
  isConfirmed: boolean
}): Promise<ActionResult> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ is_confirmed: input.isConfirmed })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.setVendorConfirmed', error.message) }

  revalidatePath('/admin')
  return { ok: true }
}
