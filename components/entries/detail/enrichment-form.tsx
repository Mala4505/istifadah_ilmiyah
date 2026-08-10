'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
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
import { Textarea } from '@/components/ui/textarea'
import { saveEntryEnrichment } from '@/lib/actions/entry-enrichment'
import type { AdminHeadOption, BudgetCategoryOption, ZoneOption } from './types'

const NONE = '__none__'

export function EnrichmentForm({
  entryId,
  adminHeadOptions,
  zoneOptions,
  budgetCategoryOptions,
  initialAdminHeadId,
  initialZoneId,
  initialBudgetCategoryId,
  initialRemark,
  hasDepartment,
}: {
  entryId: number
  adminHeadOptions: AdminHeadOption[]
  zoneOptions: ZoneOption[]
  budgetCategoryOptions: BudgetCategoryOption[]
  initialAdminHeadId: number | null
  initialZoneId: number | null
  initialBudgetCategoryId: number | null
  initialRemark: string | null
  hasDepartment: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [adminHeadId, setAdminHeadId] = useState<string>(initialAdminHeadId ? String(initialAdminHeadId) : NONE)
  const [zoneId, setZoneId] = useState<string>(initialZoneId ? String(initialZoneId) : NONE)
  const [budgetCategoryId, setBudgetCategoryId] = useState<string>(
    initialBudgetCategoryId ? String(initialBudgetCategoryId) : NONE
  )
  const [remark, setRemark] = useState(initialRemark ?? '')

  function handleSave() {
    startTransition(async () => {
      const result = await saveEntryEnrichment({
        entryId,
        adminHeadId: adminHeadId === NONE ? null : Number(adminHeadId),
        zoneId: zoneId === NONE ? null : Number(zoneId),
        budgetCategoryId: budgetCategoryId === NONE ? null : Number(budgetCategoryId),
        remark: remark || null,
      })
      if (!result.success) {
        toast.error(result.error ?? 'Could not save enrichment fields.')
        return
      }
      toast.success('Enrichment fields saved.')
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader className="space-y-0">
        <CardTitle className="text-base">Enrichment</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!hasDepartment && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            This entry has no department assigned from import, so admin head and zone options
            can&apos;t be looked up yet.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="admin-head-select">Admin head</Label>
            <Select value={adminHeadId} onValueChange={setAdminHeadId} disabled={!hasDepartment}>
              <SelectTrigger id="admin-head-select">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set</SelectItem>
                {adminHeadOptions.map((h) => (
                  <SelectItem key={h.id} value={String(h.id)}>
                    {h.head_number}. {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="zone-select">Zone</Label>
            <Select value={zoneId} onValueChange={setZoneId} disabled={!hasDepartment}>
              <SelectTrigger id="zone-select">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set</SelectItem>
                {zoneOptions.map((z) => (
                  <SelectItem key={z.id} value={String(z.id)}>
                    {z.zone_number}. {z.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="budget-category-select">Budget category</Label>
            <Select value={budgetCategoryId} onValueChange={setBudgetCategoryId}>
              <SelectTrigger id="budget-category-select">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set</SelectItem>
                {budgetCategoryOptions.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="remark">Remark</Label>
          <Textarea
            id="remark"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="Optional note for reviewers"
            rows={3}
          />
        </div>

        <div>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
