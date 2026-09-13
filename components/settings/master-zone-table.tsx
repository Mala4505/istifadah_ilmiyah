'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { createZone, updateZone } from '@/lib/actions/admin'
import type { ZoneRow } from '@/lib/settings/shape'

export function MasterZoneTable({ zones }: { zones: ZoneRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[90px]">No.</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-[90px]">Active</TableHead>
          <TableHead className="text-right">Save</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {zones.map((zone) => (
          <ZoneRowItem key={zone.id} zone={zone} />
        ))}
        <NewZoneRow />
      </TableBody>
    </Table>
  )
}

function ZoneRowItem({ zone }: { zone: ZoneRow }) {
  const [zoneNumber, setZoneNumber] = useState(String(zone.zoneNumber))
  const [name, setName] = useState(zone.name)
  const [isActive, setIsActive] = useState(zone.isActive)
  const [isPending, startTransition] = useTransition()

  const parsedNumber = Number(zoneNumber)
  const isValidNumber = zoneNumber.trim() !== '' && Number.isInteger(parsedNumber) && parsedNumber > 0
  const isValid = name.trim() !== '' && isValidNumber
  const isDirty = zoneNumber !== String(zone.zoneNumber) || name !== zone.name || isActive !== zone.isActive

  function handleSave() {
    if (!isValid) return
    startTransition(async () => {
      const result = await updateZone({ id: zone.id, zoneNumber: parsedNumber, name: name.trim(), isActive })
      if (result.ok) {
        toast.success('Zone updated.')
      } else {
        toastError(result.error, { context: 'master-zone-table' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          type="number"
          min={1}
          step={1}
          value={zoneNumber}
          onChange={(e) => setZoneNumber(e.target.value)}
          disabled={isPending}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={isPending} className="h-8 w-72" />
      </TableCell>
      <TableCell>
        <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} disabled={isPending} />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!isDirty || !isValid || isPending} onClick={handleSave}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  )
}

function NewZoneRow() {
  const [zoneNumber, setZoneNumber] = useState('')
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  const parsedNumber = Number(zoneNumber)
  const isValidNumber = zoneNumber.trim() !== '' && Number.isInteger(parsedNumber) && parsedNumber > 0
  const isValid = name.trim() !== '' && isValidNumber

  function handleAdd() {
    if (!isValid) return
    startTransition(async () => {
      const result = await createZone({ zoneNumber: parsedNumber, name: name.trim() })
      if (result.ok) {
        toast.success('Zone added.')
        setZoneNumber('')
        setName('')
      } else {
        toastError(result.error, { context: 'master-zone-table:add' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          type="number"
          min={1}
          step={1}
          value={zoneNumber}
          onChange={(e) => setZoneNumber(e.target.value)}
          placeholder="No."
          disabled={isPending}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New zone name"
          disabled={isPending}
          className="h-8 w-72"
        />
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <Button size="sm" variant="outline" disabled={!isValid || isPending} onClick={handleAdd}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
