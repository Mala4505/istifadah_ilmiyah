'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { ExportTargetSystem } from '@/lib/export/generate-status-batch'

const TARGET_SYSTEM_OPTIONS: { value: ExportTargetSystem; label: string }[] = [
  { value: 'both', label: 'Both (Departmental + Audit)' },
  { value: 'departmental', label: 'Departmental' },
  { value: 'audit', label: 'Audit' },
]

/**
 * "Generate batch" (MASTER-PLAN §3.7, §5 row 11). Every entry currently in
 * the pending queue is included regardless of which target system is
 * picked here — the queue itself has no per-entry target, only the batch
 * record does (§3.7's flow describes one queue, reviewed as a whole, then
 * pushed to whichever recipient this run is for).
 */
export function GenerateBatchForm({ pendingCount }: { pendingCount: number }) {
  const router = useRouter()
  const [targetSystem, setTargetSystem] = React.useState<ExportTargetSystem>('both')
  const [isSubmitting, setIsSubmitting] = React.useState(false)

  async function handleGenerate() {
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/export-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetSystem }),
      })
      const body = await response.json()
      if (!response.ok) {
        toast.error('Could not generate batch', { description: body.error ?? `HTTP ${response.status}` })
        return
      }
      if (body.batch === null) {
        toast.info('Nothing to export', { description: 'The pending queue is empty.' })
        return
      }
      toast.success(`Batch #${body.batch.batchId} generated`, {
        description: `${body.batch.rowCount} ${body.batch.rowCount === 1 ? 'entry' : 'entries'} · ${targetSystemLabel(targetSystem)}`,
      })
      router.refresh()
    } catch (err) {
      toast.error('Could not generate batch', { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="target-system">Target system</Label>
        <Select value={targetSystem} onValueChange={(v) => setTargetSystem(v as ExportTargetSystem)}>
          <SelectTrigger id="target-system" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_SYSTEM_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button onClick={handleGenerate} disabled={isSubmitting || pendingCount === 0}>
        {isSubmitting ? 'Generating…' : `Generate batch (${pendingCount} pending)`}
      </Button>
      {pendingCount === 0 && (
        <p className="pb-2 text-xs text-muted-foreground">Nothing is pending export right now.</p>
      )}
    </div>
  )
}

function targetSystemLabel(value: ExportTargetSystem): string {
  return TARGET_SYSTEM_OPTIONS.find((o) => o.value === value)?.label ?? value
}
