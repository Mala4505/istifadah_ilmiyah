'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SelectNative } from '@/components/ui/select-native'
import { bulkSaveEntryEnrichment } from '@/lib/actions/entry-enrichment'
import type { LookupOption } from './types'

const UNCHANGED = '__unchanged__' // omit this field from the batch update entirely
const CLEAR = '__clear__' // explicitly set this field to null for every selected entry

/**
 * Bulk zone / admin-head / cost-center assignment (hub-refinements-plan.md
 * §5, §6) — the multi-entry counterpart to the single-entry enrichment form
 * (components/entries/detail/enrichment-form.tsx), which keeps working
 * unchanged; this is additive, not a replacement. Mirrors
 * bulk-status-dialog.tsx's shape (props, toast pattern, partial-success
 * messaging) and calls the shared `bulkSaveEntryEnrichment` server action
 * (lib/actions/entry-enrichment.ts) — the same one that owns the RLS/partial-
 * success handling, so this component owns no mutation logic of its own.
 *
 * Each of the three fields defaults to "Don't change" — opt-in per field,
 * not all-or-nothing — because forcing every selected entry to the same cost
 * center just because the caller also wanted to bulk-set zone would be a
 * stronger, more destructive claim than the plan asked for (full reasoning
 * in the server action's header comment). "Clear" is a separate, explicit
 * option from "Don't change" so a batch clear is always a deliberate choice,
 * never an accidental default.
 *
 * Options are shown unfiltered by department (unlike the single-entry form's
 * department-scoped dropdowns) because a bulk selection can legitimately span
 * multiple departments at once — there's no single department to filter by.
 */
export function BulkEnrichmentDialog({
  open,
  onOpenChange,
  entryIds,
  adminHeadOptions,
  zoneOptions,
  costCenterOptions,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryIds: number[]
  adminHeadOptions: LookupOption[]
  zoneOptions: LookupOption[]
  costCenterOptions: LookupOption[]
  onDone: () => void
}) {
  const [adminHead, setAdminHead] = useState(UNCHANGED)
  const [zone, setZone] = useState(UNCHANGED)
  const [costCenter, setCostCenter] = useState(UNCHANGED)
  const [pending, setPending] = useState(false)

  function reset() {
    setAdminHead(UNCHANGED)
    setZone(UNCHANGED)
    setCostCenter(UNCHANGED)
  }

  function resolve(value: string): number | null | undefined {
    if (value === UNCHANGED) return undefined
    if (value === CLEAR) return null
    return Number(value)
  }

  async function handleSubmit() {
    if (adminHead === UNCHANGED && zone === UNCHANGED && costCenter === UNCHANGED) {
      toast.error('Choose at least one field to set or clear.')
      return
    }
    setPending(true)
    try {
      const result = await bulkSaveEntryEnrichment({
        entryIds,
        adminHeadId: resolve(adminHead),
        zoneId: resolve(zone),
        costCenterId: resolve(costCenter),
      })
      if (!result.success) {
        toast.error(result.error ?? 'Could not update entries.')
        return
      }
      if (result.updatedCount < result.requestedCount) {
        toast.warning(
          `Updated ${result.updatedCount} of ${result.requestedCount} entries — the rest were outside your access (read-only role or a different department).`
        )
      } else {
        toast.success(`Updated ${result.updatedCount} ${result.updatedCount === 1 ? 'entry' : 'entries'}.`)
      }
      reset()
      onOpenChange(false)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update entries.')
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk assign zone / admin head / cost center</DialogTitle>
          <DialogDescription>
            Applies to {entryIds.length} selected {entryIds.length === 1 ? 'entry' : 'entries'}. Leave a field on
            &quot;Don&apos;t change&quot; to skip it — only fields you set here are touched, the rest are left as
            they are.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <FieldSelect
            id="bulk-admin-head"
            label="Admin head"
            value={adminHead}
            onChange={setAdminHead}
            options={adminHeadOptions}
          />
          <FieldSelect id="bulk-zone" label="Zone" value={zone} onChange={setZone} options={zoneOptions} />
          <FieldSelect
            id="bulk-cost-center"
            label="Cost center"
            value={costCenter}
            onChange={setCostCenter}
            options={costCenterOptions}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? 'Applying…' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FieldSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  options: LookupOption[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <SelectNative id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value={UNCHANGED}>Don&apos;t change</option>
        <option value={CLEAR}>Clear (set to Not set)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </SelectNative>
    </div>
  )
}
