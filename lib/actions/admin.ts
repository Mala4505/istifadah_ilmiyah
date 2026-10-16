'use server'

import { revalidatePath, revalidateTag } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdminOrAbove, requireSuperadmin } from '@/lib/export/auth'
import { itsNumberSchema, itsNumberToLoginEmail } from '@/lib/auth/its'
import { normalizeVendorName } from '@/lib/normalize'
import { logRawError } from '@/lib/friendly-error'
import { getSelectedEvent, isEventMutable } from '@/lib/events/current'
import { REFERENCE_DATA_TAGS } from '@/lib/cache/reference-data'
import { revokeAllScrapeTokensFor } from '@/lib/scrape-token'

/** Supabase Auth ban length used to sign a deactivated account out everywhere (~100 years). */
const DEACTIVATED_BAN_DURATION = '876000h'

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

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: itsNumberToLoginEmail(itsNumber),
    password,
    email_confirm: true,
    // Security audit 1.1 (C1): user_metadata is writable by the signed-in user
    // themselves (and by anyone calling signUp), so it carries the display name
    // only. The handle_new_user trigger no longer reads access fields from it.
    // The access fields are kept in app_metadata (service-role-only) as the
    // record of intent, but GoTrue writes app_metadata AFTER the auth.users row
    // is inserted, so the trigger cannot see it -- the profile is therefore
    // promoted explicitly below, with the service key.
    app_metadata: {
      its_number: itsNumber,
      role,
      department_ids: departmentIds,
      is_active: true,
      contact_email: contactEmail || null,
    },
    user_metadata: {
      full_name: displayName,
    },
  })

  // The its_number unique index (20260810000001) is the backstop against a
  // race with the pre-check above: a losing concurrent insert fails the
  // handle_new_user trigger with a unique_violation, which createUser
  // surfaces as an error here rather than silently landing a duplicate.
  if (createError || !created?.user) {
    return { ok: false, error: logRawError('admin.createStaffUser', createError?.message ?? 'no user returned') }
  }
  const newUserId = created.user.id

  // The trigger created an inactive `dept` profile with no departments (the
  // safe default). Promote it to what the superadmin asked for. If any step
  // fails, delete the half-made account so nobody is left with an unusable
  // login and the ITS number can be retried.
  const rollback = async () => {
    const { error } = await admin.auth.admin.deleteUser(newUserId)
    if (error) logRawError('admin.createStaffUser.rollback', error.message)
  }

  const { error: profileError } = await admin
    .from('staff_profile')
    .update({
      display_name: displayName,
      role,
      is_active: true,
      its_number: itsNumber,
      contact_email: contactEmail || null,
    })
    .eq('id', newUserId)
  if (profileError) {
    logRawError('admin.createStaffUser.profile', profileError.message)
    await rollback()
    return { ok: false, error: 'Could not finish creating this account. Please try again.' }
  }

  if (departmentIds.length > 0) {
    const { error: deptError } = await admin
      .from('staff_department')
      .upsert(departmentIds.map((department_id) => ({ staff_id: newUserId, department_id })), {
        onConflict: 'staff_id,department_id',
        ignoreDuplicates: true,
      })
    if (deptError) {
      logRawError('admin.createStaffUser.departments', deptError.message)
      await rollback()
      return { ok: false, error: 'Could not finish creating this account. Please try again.' }
    }
  }

  revalidatePath('/admin')
  return { ok: true }
}

const updateStaffProfileSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(['superadmin', 'admin', 'dept']),
  departmentIds: z.array(z.number().int().positive()).max(200),
  isActive: z.boolean(),
})

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

  // Security audit 3.8 (L19): runtime validation -- a public POST endpoint.
  const parsedInput = updateStaffProfileSchema.safeParse(input)
  if (!parsedInput.success) {
    return { ok: false, error: 'That account update was not valid. Refresh the page and try again.' }
  }
  input = parsedInput.data

  // Self-lockout guard: the gate above already proves the acting user is an
  // *active superadmin*, so if they're editing their own row, any move away
  // from that (a role other than superadmin, or deactivating) is a potential
  // lockout with no undo path if they're the last superadmin. The client
  // (components/admin/users-table.tsx) asks for confirmation first, but that
  // is only UX -- this is the authoritative check, since the action can be
  // called directly bypassing the client guard entirely.
  if (input.id === gate.staff.userId && (input.role !== 'superadmin' || !input.isActive)) {
    return {
      ok: false,
      error: 'You cannot remove your own superadmin access or deactivate your own account. Ask another superadmin to make this change.',
    }
  }

  const supabase = await createClient()

  // What the account looks like now, so we know whether this save deactivates,
  // reactivates or demotes it (security audit 3.5).
  const { data: before, error: beforeError } = await supabase
    .from('staff_profile')
    .select('role, is_active')
    .eq('id', input.id)
    .maybeSingle()
  if (beforeError) return { ok: false, error: logRawError('admin.updateStaffProfile:lookup', beforeError.message) }
  if (!before) return { ok: false, error: 'That account could not be found.' }

  const { error } = await supabase
    .from('staff_profile')
    .update({ role: input.role, is_active: input.isActive })
    .eq('id', input.id)

  if (error) return { ok: false, error: logRawError('admin.updateStaffProfile:profile', error.message) }

  // Security audit 3.5 (M5 + D9): access that has been taken away must really
  // stop. (a) Scrape tokens the person minted keep working for up to 30 days
  // otherwise -> revoke them when the account is deactivated or demoted below
  // admin. (b) A deactivated account must be signed out on every device ->
  // supabase-js `auth.admin.signOut(jwt)` needs the user's own JWT, which we
  // do not have, so the account is banned instead (refresh tokens stop working;
  // every gated action here also re-reads is_active, so an access token that is
  // still within its short lifetime is refused too). Reactivation lifts the ban.
  const deactivating = !input.isActive
  const demotedBelowAdmin = input.role === 'dept' && before.role !== 'dept'
  const reactivating = input.isActive && before.is_active === false
  const authAdmin = createAdminClient()
  let accessCleanupFailed = false

  if (deactivating || demotedBelowAdmin) {
    try {
      await revokeAllScrapeTokensFor(input.id, gate.staff.userId)
    } catch (err) {
      accessCleanupFailed = true
      logRawError('admin.updateStaffProfile:revokeTokens', err instanceof Error ? err.message : String(err))
    }
  }
  if (deactivating) {
    const { error: banError } = await authAdmin.auth.admin.updateUserById(input.id, {
      ban_duration: DEACTIVATED_BAN_DURATION,
    })
    if (banError) {
      accessCleanupFailed = true
      logRawError('admin.updateStaffProfile:ban', banError.message)
    }
  } else if (reactivating) {
    const { error: unbanError } = await authAdmin.auth.admin.updateUserById(input.id, { ban_duration: 'none' })
    if (unbanError) {
      logRawError('admin.updateStaffProfile:unban', unbanError.message)
      return {
        ok: false,
        error: 'The account was reactivated, but signing in could not be re-enabled. Save again to retry.',
      }
    }
  }

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
  if (accessCleanupFailed) {
    return {
      ok: false,
      error:
        'The changes were saved, but signing this person out everywhere did not fully finish. Save again to retry.',
    }
  }
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
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Mapping budget heads is an admin-only action.' }
  const parsed = updateBudgetHeadMappingSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That budget head mapping was not valid.' }
  input = parsed.data

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
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Merging vendors is an admin-only action.' }
  const parsed = mergeVendorSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Those vendors were not valid. Refresh the page and try again.' }
  input = parsed.data

  if (input.vendorId === input.targetVendorId) {
    return { ok: false, error: 'A vendor cannot be merged into itself.' }
  }

  const supabase = await createClient()

  // Security audit 3.8 (L19): the vendor being merged away must not itself be a
  // merge root with others already merged into it -- those would be left
  // pointing at a vendor that is no longer a root (a chain, not the flat
  // root-plus-aliases shape cluster_group_id is meant to hold).
  const { data: dependents, error: dependentsError } = await supabase
    .from('vendor')
    .select('id')
    .eq('cluster_group_id', input.vendorId)
    .limit(1)
  if (dependentsError) return { ok: false, error: logRawError('admin.mergeVendor:dependents', dependentsError.message) }
  if ((dependents ?? []).length > 0) {
    return {
      ok: false,
      error:
        'Other vendors are already merged into this one. Merge into this vendor instead, or unmerge them first.',
    }
  }

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

  revalidatePath('/settings')
  return { ok: true }
}

/** Undoes a vendor merge, restoring it as an independent identity. */
export async function unmergeVendor(input: { vendorId: number }): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Unmerging vendors is an admin-only action.' }
  const parsed = vendorIdOnlySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That vendor was not valid. Refresh the page and try again.' }
  input = parsed.data

  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ cluster_group_id: null })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.unmergeVendor', error.message) }

  revalidatePath('/settings')
  return { ok: true }
}

const updateBudgetHeadMappingSchema = z.object({
  budgetHeadId: z.number().int().positive(),
  headId: z.number().int().positive().nullable(),
})

const mergeVendorSchema = z.object({
  vendorId: z.number().int().positive(),
  targetVendorId: z.number().int().positive(),
})

const vendorIdOnlySchema = z.object({ vendorId: z.number().int().positive() })

const setVendorConfirmedSchema = z.object({
  vendorId: z.number().int().positive(),
  isConfirmed: z.boolean(),
})

const renameVendorSchema = z.object({
  vendorId: z.number().int().positive(),
  displayName: z.string().trim().min(1, 'Vendor name is required.').max(200, 'Vendor name is too long.'),
})

/**
 * Renames a vendor from Settings -> Vendors (user decision 2026-09-07:
 * "label + identity key"). Updates both `display_name` (the label shown
 * everywhere) AND `normalized_name` (the unique identity key the
 * import/OCR resolution rule matches on -- 20260808000008_vendor_and_alias.sql),
 * regenerating the latter from the new name via `normalizeVendorName` so the
 * rename actually "takes": a later import or bill spelled the new way now
 * resolves to this vendor instead of creating a fresh one.
 *
 * Two guards on the identity key:
 *  - the new name must still normalize to something non-empty;
 *  - if another vendor already owns that normalized key, this is a merge
 *    situation, not a rename -- refuse and point the admin at "Merge into...".
 *
 * The OLD normalized key is recorded as a `manual` `vendor_alias` for this
 * same vendor (best-effort, service-role client -- `vendor_alias` has no
 * write policy for `authenticated`, same reason as review.ts's alias
 * learning) so bills/entries imported under the previous spelling still
 * resolve here. Admin-level gate to match the `vendor_update_admin` RLS
 * floor (20260808000026_rls_policies.sql).
 */
export async function renameVendor(input: {
  vendorId: number
  displayName: string
}): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) {
    return { ok: false, error: 'Renaming a vendor is an admin-only action.' }
  }

  const parsed = renameVendorSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }
  const { vendorId, displayName } = parsed.data

  const normalized = normalizeVendorName(displayName)
  if (!normalized) {
    return { ok: false, error: 'That name has no letters or digits to identify the vendor by.' }
  }

  const supabase = await createClient()

  const { data: current, error: currentError } = await supabase
    .from('vendor')
    .select('id, display_name, normalized_name')
    .eq('id', vendorId)
    .single()

  if (currentError || !current) {
    return { ok: false, error: 'That vendor no longer exists.' }
  }

  if (current.display_name === displayName && current.normalized_name === normalized) {
    return { ok: true }
  }

  if (normalized !== current.normalized_name) {
    const { data: clash } = await supabase
      .from('vendor')
      .select('id, display_name')
      .eq('normalized_name', normalized)
      .neq('id', vendorId)
      .maybeSingle()
    if (clash) {
      return {
        ok: false,
        error: `"${clash.display_name}" already uses that name. Use "Merge into..." to combine the two instead of renaming.`,
      }
    }
  }

  const { error: updateError } = await supabase
    .from('vendor')
    .update({ display_name: displayName, normalized_name: normalized })
    .eq('id', vendorId)

  if (updateError) {
    return { ok: false, error: logRawError('admin.renameVendor', updateError.message) }
  }

  // Keep the old spelling resolvable. Best-effort: a failure here does not
  // undo a rename that already succeeded.
  if (current.normalized_name && current.normalized_name !== normalized) {
    const { error: aliasError } = await createAdminClient()
      .from('vendor_alias')
      .upsert(
        { vendor_id: vendorId, raw_name: current.normalized_name, source: 'manual' },
        { onConflict: 'raw_name', ignoreDuplicates: true },
      )
    if (aliasError) logRawError('admin.renameVendor:alias', aliasError.message)
  }

  revalidatePath('/settings')
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

  const selectedEvent = await getSelectedEvent()
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
  const gate = await requireAdminOrAbove()
  if (!gate.ok) return { ok: false, error: 'Confirming a vendor is an admin-only action.' }
  const parsed = setVendorConfirmedSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That vendor was not valid. Refresh the page and try again.' }
  input = parsed.data

  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ is_confirmed: input.isConfirmed })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.setVendorConfirmed', error.message) }

  revalidatePath('/settings')
  return { ok: true }
}

/**
 * Turns a vendor's line-item template on/off (20260912000001). Independent of
 * whether any template rows exist -- the UI (vendor-line-item-template.tsx)
 * disables the checkbox until at least one row is saved, but the column
 * itself has no such constraint, so an empty-template enable is harmless
 * (applyLineItemTemplate in review-workspace.tsx no-ops when there are no
 * rows to apply).
 */
export async function setVendorTemplateEnabled(input: {
  vendorId: number
  enabled: boolean
}): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) {
    return { ok: false, error: 'Managing a vendor line-item template is an admin-only action.' }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ use_line_item_template: input.enabled })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.setVendorTemplateEnabled', error.message) }

  revalidatePath('/settings')
  return { ok: true }
}

/**
 * Marks a vendor as issuing no bills (20260929000001, e.g. Burhani Hospital
 * Surat). Its entries -- and those of vendors merged into it -- drop out of
 * "Awaiting bill" and the undocumented-spend report. Admin-only, same posture
 * as the line-item template toggle above.
 */
export async function setVendorBillNotRequired(input: {
  vendorId: number
  billNotRequired: boolean
}): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) {
    return { ok: false, error: 'Marking a vendor as needing no bills is an admin-only action.' }
  }

  const supabase = await createClient()

  const { error } = await supabase
    .from('vendor')
    .update({ bill_not_required: input.billNotRequired })
    .eq('id', input.vendorId)

  if (error) return { ok: false, error: logRawError('admin.setVendorBillNotRequired', error.message) }

  revalidatePath('/settings')
  revalidatePath('/entries')
  return { ok: true }
}

const saveVendorLineItemTemplateSchema = z.object({
  vendorId: z.number().int().positive(),
  descriptions: z
    .array(z.string().trim().min(1, 'A line-item description cannot be blank.').max(300, 'Description is too long.'))
    .max(50, 'A template cannot hold more than 50 lines.'),
})

/**
 * Replaces a vendor's whole line-item template in one go (seed, reorder, add,
 * remove and rename all funnel through this -- the caller always sends the
 * complete ordered list rather than a per-row diff, same "replace-all"
 * simplicity as a small settings list). `line_order` is the array index, so
 * reordering in the UI and re-saving is enough to persist a new order.
 *
 * Delete-then-insert rather than upsert: an empty array is a valid save (it
 * clears the template), and row count can shrink between saves, which upsert
 * alone wouldn't reconcile.
 */
export async function saveVendorLineItemTemplate(input: {
  vendorId: number
  descriptions: string[]
}): Promise<ActionResult> {
  const gate = await requireAdminOrAbove()
  if (!gate.ok) {
    return { ok: false, error: 'Managing a vendor line-item template is an admin-only action.' }
  }

  const parsed = saveVendorLineItemTemplateSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }
  const { vendorId, descriptions } = parsed.data

  const supabase = await createClient()

  const { error: deleteError } = await supabase
    .from('vendor_line_item_template')
    .delete()
    .eq('vendor_id', vendorId)

  if (deleteError) {
    return { ok: false, error: logRawError('admin.saveVendorLineItemTemplate:clear', deleteError.message) }
  }

  if (descriptions.length > 0) {
    const { error: insertError } = await supabase.from('vendor_line_item_template').insert(
      descriptions.map((description, index) => ({
        vendor_id: vendorId,
        line_order: index,
        description,
      })),
    )
    if (insertError) {
      return { ok: false, error: logRawError('admin.saveVendorLineItemTemplate:insert', insertError.message) }
    }
  }

  revalidatePath('/settings')
  return { ok: true }
}

// ============================================================================
// Master data CRUD (Settings -> Master data, 2026-09-13): department,
// sub_department, zone, and admin_head were previously seeded/read-only --
// "editing them is a migration, not an admin action" per the old master-data
// page copy, with no insert/update RLS policy for `authenticated` at all
// (20260808000026_rls_policies.sql's own comment). The
// 20260913000001_admin_head_zone_drop_department migration adds
// superadmin-scoped insert/update policies on all four tables (and drops
// admin_head/zone's department_id entirely -- see that migration's header),
// so these actions write through the normal session client and rely on RLS
// as the real gate, with the same app-level requireSuperadmin() floor
// updateSubDepartmentBudget/updateStaffProfile already use as a stricter,
// explicit check ahead of the database's own.
//
// No delete action: every one of these tables has an is_active flag
// (deactivate, not delete) precisely so a retired row still resolves a name
// for any entry/budget-head/event-membership row that already points at it,
// instead of going blank -- same reasoning department_select's "no delete
// policy at all" note gives for entries.
// ============================================================================

function friendlyMasterDataError(context: string, error: { code?: string; message: string }): string {
  if (error.code === '23505') {
    return 'That name or number is already in use -- pick a different one.'
  }
  return logRawError(context, error.message)
}

/**
 * A freshly created department/sub_department/zone/admin_head is invisible
 * everywhere until it's also a member of the currently selected event --
 * every dropdown (entries, review, documents, the entries filter bar, this
 * same Settings area) filters options through event_department/
 * event_sub_department/event_zone/event_admin_head, not just the master
 * table itself (see loadMasterData.ts, app/(app)/entries/[id]/page.tsx,
 * etc.). None of those four junction tables has an insert policy for
 * `authenticated` (rows are meant to come from createEvent's raw-SQL insert
 * or the one-time backfill in 20260822000005_event_scoping.sql /
 * 20260825000003_event_sub_department.sql), so this writes through the
 * service-role admin client -- safe here because every caller already ran
 * requireSuperadmin() first. No-ops when there's no resolvable selected
 * event, matching every loader's "no event -> no filtering" fallback
 * (an unscoped app just shows every row regardless of membership).
 */
async function addToSelectedEventMembership(
  table: 'event_department' | 'event_sub_department' | 'event_zone' | 'event_admin_head',
  column: 'department_id' | 'sub_department_id' | 'zone_id' | 'admin_head_id',
  id: number,
): Promise<void> {
  const selectedEvent = await getSelectedEvent()
  if (!selectedEvent) return

  const admin = createAdminClient()
  const { error } = await admin.from(table).insert({ event_id: selectedEvent.id, [column]: id })
  if (error) logRawError(`admin.addToSelectedEventMembership:${table}`, error.message)
}

const createDepartmentSchema = z.object({
  name: z.string().trim().min(1, 'Give the department a name.'),
})

export async function createDepartment(input: { name: string }): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = createDepartmentSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('department')
    .insert({ name: parsed.data.name })
    .select('id')
    .single()
  if (error) return { ok: false, error: friendlyMasterDataError('admin.createDepartment', error) }

  await addToSelectedEventMembership('event_department', 'department_id', data.id)

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.department)
  return { ok: true }
}

const updateDepartmentSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the department a name.'),
  isActive: z.boolean(),
})

export async function updateDepartment(input: {
  id: number
  name: string
  isActive: boolean
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = updateDepartmentSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase
    .from('department')
    .update({ name: parsed.data.name, is_active: parsed.data.isActive })
    .eq('id', parsed.data.id)
  if (error) return { ok: false, error: friendlyMasterDataError('admin.updateDepartment', error) }

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.department)
  return { ok: true }
}

const createSubDepartmentSchema = z.object({
  departmentId: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the sub-department a name.'),
})

export async function createSubDepartment(input: {
  departmentId: number
  name: string
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = createSubDepartmentSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('sub_department')
    .insert({ department_id: parsed.data.departmentId, name: parsed.data.name })
    .select('id')
    .single()
  if (error) return { ok: false, error: friendlyMasterDataError('admin.createSubDepartment', error) }

  await addToSelectedEventMembership('event_sub_department', 'sub_department_id', data.id)

  revalidatePath('/settings')
  return { ok: true }
}

const updateSubDepartmentSchema = z.object({
  id: z.number().int().positive(),
  departmentId: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the sub-department a name.'),
  isActive: z.boolean(),
})

export async function updateSubDepartment(input: {
  id: number
  departmentId: number
  name: string
  isActive: boolean
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = updateSubDepartmentSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase
    .from('sub_department')
    .update({
      department_id: parsed.data.departmentId,
      name: parsed.data.name,
      is_active: parsed.data.isActive,
    })
    .eq('id', parsed.data.id)
  if (error) return { ok: false, error: friendlyMasterDataError('admin.updateSubDepartment', error) }

  revalidatePath('/settings')
  return { ok: true }
}

const createZoneSchema = z.object({
  zoneNumber: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the zone a name.'),
})

export async function createZone(input: { zoneNumber: number; name: string }): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = createZoneSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('zone')
    .insert({ zone_number: parsed.data.zoneNumber, name: parsed.data.name })
    .select('id')
    .single()
  if (error) return { ok: false, error: friendlyMasterDataError('admin.createZone', error) }

  await addToSelectedEventMembership('event_zone', 'zone_id', data.id)

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.zone)
  return { ok: true }
}

const updateZoneSchema = z.object({
  id: z.number().int().positive(),
  zoneNumber: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the zone a name.'),
  isActive: z.boolean(),
})

export async function updateZone(input: {
  id: number
  zoneNumber: number
  name: string
  isActive: boolean
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = updateZoneSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase
    .from('zone')
    .update({ zone_number: parsed.data.zoneNumber, name: parsed.data.name, is_active: parsed.data.isActive })
    .eq('id', parsed.data.id)
  if (error) return { ok: false, error: friendlyMasterDataError('admin.updateZone', error) }

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.zone)
  return { ok: true }
}

const createAdminHeadSchema = z.object({
  headNumber: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the admin head a name.'),
})

export async function createAdminHead(input: { headNumber: number; name: string }): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = createAdminHeadSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('admin_head')
    .insert({ head_number: parsed.data.headNumber, name: parsed.data.name })
    .select('id')
    .single()
  if (error) return { ok: false, error: friendlyMasterDataError('admin.createAdminHead', error) }

  await addToSelectedEventMembership('event_admin_head', 'admin_head_id', data.id)

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.adminHead)
  return { ok: true }
}

const updateAdminHeadSchema = z.object({
  id: z.number().int().positive(),
  headNumber: z.number().int().positive(),
  name: z.string().trim().min(1, 'Give the admin head a name.'),
  isActive: z.boolean(),
})

export async function updateAdminHead(input: {
  id: number
  headNumber: number
  name: string
  isActive: boolean
}): Promise<ActionResult> {
  const gate = await requireSuperadmin()
  if (!gate.ok) return { ok: false, error: 'Editing master data is a superadmin-only action.' }

  const parsed = updateAdminHeadSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]!.message }

  const supabase = await createClient()
  const { error } = await supabase
    .from('admin_head')
    .update({ head_number: parsed.data.headNumber, name: parsed.data.name, is_active: parsed.data.isActive })
    .eq('id', parsed.data.id)
  if (error) return { ok: false, error: friendlyMasterDataError('admin.updateAdminHead', error) }

  revalidatePath('/settings')
  revalidateTag(REFERENCE_DATA_TAGS.adminHead)
  return { ok: true }
}
