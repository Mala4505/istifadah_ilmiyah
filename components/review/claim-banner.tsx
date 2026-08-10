'use client'

// §7 concurrency rule: "Another reviewer sees 'Being reviewed by Fatema --
// take over?' rather than silently overwriting."

import { Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatDateTime } from '@/lib/reports/format'

export function ClaimBanner({
  status,
  claimedByDisplayName,
  claimedAt,
  onTakeOver,
  isPending,
}: {
  status: 'checking' | 'mine' | 'blocked'
  claimedByDisplayName: string | null
  claimedAt: string | null
  onTakeOver: () => void
  isPending: boolean
}) {
  if (status === 'checking') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Checking claim…
      </div>
    )
  }

  if (status === 'mine') return null

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
      <ShieldAlert className="h-4 w-4 flex-shrink-0" />
      <span>
        Being reviewed by <strong>{claimedByDisplayName ?? 'another reviewer'}</strong>
        {claimedAt ? ` since ${formatDateTime(claimedAt)}` : ''} -- take over?
      </span>
      <Button type="button" size="sm" variant="outline" onClick={onTakeOver} disabled={isPending} className="ml-auto">
        {isPending ? 'Taking over…' : 'Take over'}
      </Button>
    </div>
  )
}
