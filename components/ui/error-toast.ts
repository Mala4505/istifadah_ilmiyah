'use client'

import { toast } from 'sonner'
import { friendlyErrorMessage, logRawError } from '@/lib/friendly-error'

/**
 * The only way a failure should reach a toast. A toast has no room for a
 * "technical detail" toggle the way components/ui/friendly-error.tsx does, so
 * the raw string never appears in one at all — it goes to the browser console
 * (and Sentry, which instruments console.error) under `context`, and the user
 * reads plain English.
 *
 * Server actions in this app return `{ ok: false, error }` where `error` is
 * frequently a Postgres or PostgREST message, so `toast.error(result.error)`
 * put constraint names and JSON blobs on screen. Route every one of those
 * through here instead.
 *
 * `title` overrides the derived sentence when the call site knows a better
 * one for the specific action ("Could not attach the document"); the derived
 * sentence then becomes the toast's description, so the user still gets the
 * cause as well as the context.
 */
export function toastError(
  raw: string | null | undefined,
  options?: { title?: string; context?: string }
): void {
  logRawError(options?.context ?? 'action-error', raw)
  const friendly = friendlyErrorMessage(raw)
  if (options?.title && options.title !== friendly) {
    toast.error(options.title, { description: friendly })
    return
  }
  toast.error(friendly)
}
