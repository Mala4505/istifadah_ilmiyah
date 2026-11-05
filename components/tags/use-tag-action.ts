'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'

/**
 * Runs one Tags server action the way every Tags control does: a pending flag while it
 * runs, a plain-English toast on failure (toastError -- the raw text only goes to the
 * console), a success toast and a router refresh otherwise. Returns true on success so a
 * dialog can close itself.
 */
export function useTagAction(context: string) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function run(
    action: () => Promise<{ ok: true } | { ok: false; error: string }>,
    options: { success?: string; failureTitle?: string; onSuccess?: () => void } = {}
  ) {
    startTransition(async () => {
      try {
        const result = await action()
        if (!result.ok) {
          toastError(result.error, { context, title: options.failureTitle })
          return
        }
        if (options.success) toast.success(options.success)
        options.onSuccess?.()
        router.refresh()
      } catch (err) {
        toastError(err instanceof Error ? err.message : null, { context, title: options.failureTitle })
      }
    })
  }

  return { pending, run }
}
