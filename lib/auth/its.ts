import 'server-only'
import { z } from 'zod'
import { serverEnv } from '@/lib/env.server'

/**
 * ITS number: the 8-digit member ID staff log in with. Supabase Auth still
 * requires an email-shaped identifier for signInWithPassword/admin.createUser,
 * so every ITS number maps deterministically to a synthetic
 * `<its_number>@ITS_LOGIN_EMAIL_DOMAIN` address that becomes auth.users.email
 * — Supabase's login handle only, never a real mailbox and never shown to
 * anyone. The real contact email (if any) lives separately in
 * staff_profile.contact_email.
 */
export const itsNumberSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{8}$/, 'ITS number must be exactly 8 digits.')

export function itsNumberToLoginEmail(itsNumber: string): string {
  return `${itsNumber}@${serverEnv.ITS_LOGIN_EMAIL_DOMAIN}`
}
