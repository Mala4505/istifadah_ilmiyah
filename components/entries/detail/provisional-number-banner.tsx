'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Hash } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { replaceProvisionalUbblNumber } from '@/lib/actions/entries'

/**
 * The second half of the typed-entry flow (confirmed 2026-08-19): an entry
 * keyed in here carries a provisional `M-` number until the real UBBL number
 * arrives on paper, and this is where the swap happens.
 *
 * Rendered only while the number still has the prefix, so it disappears the
 * moment the real number is in — an entry that has been reconciled with its
 * paperwork should look no different from an imported one. The swap goes
 * through an ordinary UPDATE, so it lands in the change history with both the
 * old and the new number.
 */
export function ProvisionalNumberBanner({
  entryId,
  provisionalNumber,
}: {
  entryId: number
  provisionalNumber: string
}) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [pending, setPending] = useState(false)

  async function handleSave() {
    if (!value.trim()) {
      toast.error('Enter the UBBL number from the paperwork.')
      return
    }
    setPending(true)
    try {
      const result = await replaceProvisionalUbblNumber({ entryId, ubblNumber: value })
      if (!result.ok) {
        toastError(result.error, { title: 'Could not save the number', context: 'provisional-number-banner' })
        return
      }
      toast.success(`Entry number set to ${value.trim()}.`)
      setValue('')
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        title: 'Could not save the number',
        context: 'provisional-number-banner',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400">
        <Hash className="h-3.5 w-3.5" aria-hidden="true" />
        Temporary entry number
      </div>
      <p className="text-sm text-muted-foreground">
        This entry was typed in, so it was given the temporary number{' '}
        <span className="font-mono text-foreground">{provisionalNumber}</span>. Replace it with the real UBBL number
        once you have the paperwork — the change is recorded in the change history.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1.5">
          <Label htmlFor="real-ubbl-number">Real UBBL number</Label>
          <Input
            id="real-ubbl-number"
            value={value}
            placeholder="As printed on the paperwork"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSave()
            }}
          />
        </div>
        <Button onClick={handleSave} disabled={pending}>
          {pending ? 'Saving…' : 'Replace number'}
        </Button>
      </div>
    </div>
  )
}
