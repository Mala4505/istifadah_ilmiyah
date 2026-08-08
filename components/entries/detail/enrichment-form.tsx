'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
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
import type { HeadOption, ZoneOption } from './types'

const NONE = '__none__'

export function EnrichmentForm({
  entryId,
  headOptions,
  zoneOptions,
  initialHeadId,
  initialZoneId,
  initialHubReference,
  initialEnrichmentNote,
  hasDepartment,
}: {
  entryId: number
  headOptions: HeadOption[]
  zoneOptions: ZoneOption[]
  initialHeadId: number | null
  initialZoneId: number | null
  initialHubReference: string | null
  initialEnrichmentNote: string | null
  hasDepartment: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [headId, setHeadId] = useState<string>(initialHeadId ? String(initialHeadId) : NONE)
  const [zoneId, setZoneId] = useState<string>(initialZoneId ? String(initialZoneId) : NONE)
  const [hubReference, setHubReference] = useState(initialHubReference ?? '')
  const [enrichmentNote, setEnrichmentNote] = useState(initialEnrichmentNote ?? '')

  function handleSave() {
    startTransition(async () => {
      const result = await saveEntryEnrichment({
        entryId,
        headId: headId === NONE ? null : Number(headId),
        zoneId: zoneId === NONE ? null : Number(zoneId),
        hubReference: hubReference || null,
        enrichmentNote: enrichmentNote || null,
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
            This entry has no department assigned from import, so head and zone options can&apos;t
            be looked up yet.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="head-select">Head</Label>
            <Select value={headId} onValueChange={setHeadId} disabled={!hasDepartment}>
              <SelectTrigger id="head-select">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not set</SelectItem>
                {headOptions.map((h) => (
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
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hub-reference">Hub reference</Label>
          <Input
            id="hub-reference"
            value={hubReference}
            onChange={(e) => setHubReference(e.target.value)}
            placeholder="Optional reference"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="enrichment-note">Enrichment note</Label>
          <Textarea
            id="enrichment-note"
            value={enrichmentNote}
            onChange={(e) => setEnrichmentNote(e.target.value)}
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
