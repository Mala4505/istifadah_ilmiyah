'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { requireAdmin } from '@/lib/export/auth'
import { itsNumberSchema, itsNumberToLoginEmail } from '@/lib/auth/its'

type ActionResult = { ok: true } | { ok: false; error: string }

const createStaffUserSchema = z.object({
  itsNumber: itsNumberSchema,
  displayName: z.string().trim().min(1, 'Name is required.'),
  contactEmail: z.union([z.string().trim().email('Enter a valid email address.'), z.literal('')]),
  role: z.enum(['admin', 'reviewer', 'viewer']),
  departmentId: z.number().int().nullable(),
  password: z.string().min(10, 'Password must be at least 10 characters.'),
})

/**
 * Admin-provisioned account creation — the only way a staff account is
 * created now (§4.4c: nobody self-serves into access). Writes through the
 * service-role admin client, which bypasses RLS entirely, so the admin gate
 * here is the only thing standing in front of it — checked with the
 * session-bound client FIRST, same pattern as app/api/import/route.ts.
 * ITS number becomes Supabase Auth's internal login identifier
 * (lib/auth/its.ts); the account lands active immediately, since an admin
 * explicitly provisioning it is a stronger signal than the self-signup
 * trigger's inactive-by-default fallback (20260810000001).
 */
export async function createStaffUser(input: {
  itsNumber: string
  displayName: string
  contactEmail: string
  role: 'admin' | 'reviewer' | 'viewer'
  departmentId: number | null
  password: string
}): Promise<ActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) {
    return { ok: false, error: 'Creating staff accounts is an admin-only action.' }
  }

  const parsed = createStaffUserSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]!.message }
  }
  const { itsNumber, displayName, contactEmail, role, departmentId, password } = parsed.data

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
      department_id: departmentId === null ? '' : String(departmentId),
      is_active: true,
      contact_email: contactEmail || null,
    },
  })

  // The its_number unique index (20260810000001) is the backstop against a
  // race with the pre-check above: a losing concurrent insert fails the
  // handle_new_user trigger with a unique_violation, which createUser
  // surfaces as an error here rather than silently landing a duplicate.
  if (createError) return { ok: false, error: createError.message }

  revalidatePath('/admin')
  return { ok: true }
}

/**
 * Updates a staff member's role, department, or active flag (§4.4c —
 * "Manage users, roles, department assignment" is admin-only). RLS
 * (staff_profile_update, 20260808000026) already locks those three columns
 * to admin writers; this action relies on the database to enforce that and
 * surfaces its error rather than re-checking the role here.
 */
export async function updateStaffProfile(input: {
  id: string
  role: 'admin' | 'reviewer' | 'viewer'
  departmentId: number | null
  isActive: boolean
}): Promise<ActionResult> {
  const supabase = await createClient()

  const { error } = await supabase
    .from('staff_profile')
    .update({ role: input.role, department_id: input.departmentId, is_active: input.isActive })
    .eq('id', input.id)

  if (error) return { ok: false, error: error.message }

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

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin')
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

  if (error) return { ok: false, error: error.message }

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

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin')
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

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin')
  return { ok: true }
}
