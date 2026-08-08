'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { setHubStatus } from '@/lib/actions/hub-status'
import { formatIsoDate } from './format'
import { HubStatusTimeline } from './hub-status-timeline'
import type { ChangeLogRow, HubStatusOption } from './types'

const STATUS_BADGE_VARIANT: Record<string, 'muted' | 'warning' | 'default'> = {
  not_set: 'muted',
  awaiting_verification: 'warning',
  awaiting_validation: 'default',
}

export function HubStatusSection({
  entryId,
  hubStatusCode,
  hubStatusLabel,
  hubStatusExportedAt,
  hubStatusOptions,
  timelineRows,
  resolveChangedBy,
}: {
  entryId: number
  hubStatusCode: string
  hubStatusLabel: string
  hubStatusExportedAt: string | null
  hubStatusOptions: HubStatusOption[]
  timelineRows: ChangeLogRow[]
  resolveChangedBy: (userId: string | null) => string
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [selectedCode, setSelectedCode] = useState(hubStatusCode)
  const [note, setNote] = useState('')

  const hubStatusById = new Map(hubStatusOptions.map((s) => [s.id, s]))

  function handleSubmit() {
    const trimmed = note.trim()
    if (!trimmed) {
      toast.error('A note is required to change Hub status.')
      return
    }
    startTransition(async () => {
      const result = await setHubStatus({
        entryIds: [entryId],
        hubStatusCode: selectedCode,
        note: trimmed,
      })
      if (!result.success) {
        toast.error(result.error ?? 'Could not update Hub status.')
        return
      }
      if (result.error) {
        // Partial success is not reachable for a single-entry call, but
        // handled defensively since setHubStatus is the shared bulk action too.
        toast.warning(result.error)
      } else {
        toast.success('Hub status updated.')
      }
      setNote('')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="space-y-0">
        <CardTitle className="text-base">Hub status</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant={STATUS_BADGE_VARIANT[hubStatusCode] ?? 'default'} className="text-sm">
            {hubStatusLabel}
          </Badge>
          <span className="text-sm text-muted-foreground">
            {hubStatusExportedAt
              ? `Exported ${formatIsoDate(hubStatusExportedAt)}`
              : 'Pending export'}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,220px)_1fr] sm:items-start">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hub-status-select">New status</Label>
            <Select value={selectedCode} onValueChange={setSelectedCode}>
              <SelectTrigger id="hub-status-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hubStatusOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.code}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="hub-status-note">Note (required)</Label>
            <Textarea
              id="hub-status-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why is the status changing?"
              rows={2}
            />
          </div>
        </div>

        <div>
          <Button onClick={handleSubmit} disabled={isPending || !note.trim()}>
            {isPending ? 'Updating…' : 'Update status'}
          </Button>
        </div>

        <Separator />

        <div>
          <h3 className="mb-2 text-sm font-medium">Status history</h3>
          <HubStatusTimeline
            rows={timelineRows}
            hubStatusById={hubStatusById}
            resolveChangedBy={resolveChangedBy}
          />
        </div>
      </CardContent>
    </Card>
  )
}
