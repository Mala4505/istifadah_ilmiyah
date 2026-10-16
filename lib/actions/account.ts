'use server'

import { z } from 'zod'
import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStaffContext, getCachedStaffProfile } from '@/lib/export/auth'
import { publicEnv } from '@/lib/env'
import { logRawError } from '@/lib/friendly-error'
import { itsNumberToLoginEmail } from '@/lib/auth/its'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy'

/**
 * Self-service "Change password" (owner decision D9, security plan 6.2).
 * Lives in its own file, not lib/actions/auth.ts. Every export here is a
 * public POST endpoint, so the action authenticates for itself: it needs a
 * signed-in, ACTIVE staff member and acts only on THAT user -- there is no
 * user-id parameter to tamper with.
 */

export type ChangePasswordResult = { ok: true } | { ok: false; error: string }

const WRONG_CURRENT = 'Your current password is not correct.'
const TOO_MANY = 'Too many wrong attempts. Please wait 15 minutes and try again.'
const GENERIC_FAILURE = 'We could not change your password. Please try again in a moment.'

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.').max(MAX_PASSWORD_LENGTH * 2),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters long.`)
      .max(MAX_PASSWORD_LENGTH, `Your new password can be at most ${MAX_PASSWORD_LENGTH} characters long.`),
    confirmPassword: z.string(),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two new passwords do not match.',
  })
  .refine((v) => v.newPassword !== v.currentPassword, {
    path: ['newPassword'],
    message: 'Your new password must be different from your current one.',
  })

// Same window / ceiling as the login form's limiter (lib/actions/auth.ts), and
// the same table, so guessing the current password through this form is
// counted against the same account as guessing it on the login page.
const WINDOW_MINUTES = 15
const MAX_FAILURES = 10

export async function changeOwnPassword(input: {
  currentPassword: string
  newPassword: string
  confirmPassword: string
}): Promise<ChangePasswordResult> {
  const parsed = changePasswordSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? GENERIC_FAILURE }
  }
  const { currentPassword, newPassword } = parsed.data

  // Gate: signed in AND active. getStaffContext reads the caller's own
  // staff_profile through RLS.
  const staff = await getStaffContext()
  if (!staff) return { ok: false, error: 'You need to sign in again to change your password.' }
  if (!staff.isActive) {
    return { ok: false, error: 'Your account is pending activation, so the password cannot be changed yet.' }
  }

  const profile = await getCachedStaffProfile(staff.userId)
  const itsNumber = profile?.its_number ?? null

  // Login handle for the re-check. Prefer the ITS-derived address (the account
  // is created with it); never trust an email supplied by the client.
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()
  const loginEmail =
    userData.user?.email ?? (itsNumber ? itsNumberToLoginEmail(itsNumber) : null)
  if (!loginEmail || userData.user?.id !== staff.userId) {
    return { ok: false, error: 'You need to sign in again to change your password.' }
  }

  // Throttle repeated wrong "current password" guesses. Fails open on an
  // infra error (matches the login limiter); Supabase's own protection still
  // sits underneath.
  if (itsNumber) {
    try {
      const admin = createAdminClient()
      const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString()
      const { count } = await admin
        .from('auth_login_attempt')
        .select('id', { count: 'exact', head: true })
        .eq('its_number', itsNumber)
        .eq('success', false)
        .gt('created_at', since)
      if ((count ?? 0) >= MAX_FAILURES) return { ok: false, error: TOO_MANY }
    } catch (e) {
      logRawError('account.changeOwnPassword.throttle', e instanceof Error ? e.message : String(e))
    }
  }

  // Re-check the current password with a throwaway client that keeps no
  // session: it has no cookie adapter, persistSession is off and auto-refresh
  // is off, so the sign-in below cannot write or replace the browser's auth
  // cookies (the cookie-backed client from createClient() WOULD rotate the
  // session cookies on a successful signInWithPassword). The returned session
  // is discarded.
  const verifier = createSupabaseJsClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
  )
  const { data: verified, error: verifyError } = await verifier.auth.signInWithPassword({
    email: loginEmail,
    password: currentPassword,
  })
  if (verifyError || verified.user?.id !== staff.userId) {
    if (verifyError) logRawError('account.changeOwnPassword.verify', verifyError.message)
    if (itsNumber) {
      try {
        await createAdminClient().from('auth_login_attempt').insert({ its_number: itsNumber, ip: null, success: false })
      } catch {
        // Best-effort audit row only.
      }
    }
    // A hook/Supabase lockout and a plain wrong password both land here; the
    // verifyError code tells them apart without leaking the raw text.
    const code = (verifyError as { code?: string } | null)?.code
    if (
      code === 'over_request_rate_limit' ||
      code === 'over_email_send_rate_limit' ||
      /too many attempts/i.test(verifyError?.message ?? '') // the lockout hook's reject message
    ) {
      return { ok: false, error: TOO_MANY }
    }
    return { ok: false, error: WRONG_CURRENT }
  }

  // Change it on the real (cookie) session. updateUser here keeps the user
  // signed in on this device; other devices stay signed in too (sign-out
  // everywhere is on deactivation only, D9).
  const { error: updateError } = await supabase.auth.updateUser({ password: newPassword })
  if (updateError) {
    logRawError('account.changeOwnPassword.update', updateError.message)
    const code = (updateError as { code?: string }).code
    if (code === 'weak_password') {
      return { ok: false, error: 'That password is too easy to guess. Choose a longer or less common one.' }
    }
    if (code === 'same_password') {
      return { ok: false, error: 'Your new password must be different from your current one.' }
    }
    return { ok: false, error: GENERIC_FAILURE }
  }

  return { ok: true }
}
