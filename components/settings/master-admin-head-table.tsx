'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { createAdminHead, updateAdminHead } from '@/lib/actions/admin'
import type { HeadRow } from '@/lib/settings/loadMasterData'

export function MasterAdminHeadTable({ heads }: { heads: HeadRow[] }) {
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
        {heads.map((head) => (
          <AdminHeadRowItem key={head.id} head={head} />
        ))}
        <NewAdminHeadRow />
      </TableBody>
    </Table>
  )
}

function AdminHeadRowItem({ head }: { head: HeadRow }) {
  const router = useRouter()
  const [headNumber, setHeadNumber] = useState(String(head.headNumber))
  const [name, setName] = useState(head.name)
  const [isActive, setIsActive] = useState(head.isActive)
  const [isPending, startTransition] = useTransition()

  const parsedNumber = Number(headNumber)
  const isValidNumber = headNumber.trim() !== '' && Number.isInteger(parsedNumber) && parsedNumber > 0
  const isValid = name.trim() !== '' && isValidNumber
  const isDirty = headNumber !== String(head.headNumber) || name !== head.name || isActive !== head.isActive

  function handleSave() {
    if (!isValid) return
    startTransition(async () => {
      const result = await updateAdminHead({ id: head.id, headNumber: parsedNumber, name: name.trim(), isActive })
      if (result.ok) {
        toast.success('Admin head updated.')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-admin-head-table' })
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
          value={headNumber}
          onChange={(e) => setHeadNumber(e.target.value)}
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

function NewAdminHeadRow() {
  const router = useRouter()
  const [headNumber, setHeadNumber] = useState('')
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  const parsedNumber = Number(headNumber)
  const isValidNumber = headNumber.trim() !== '' && Number.isInteger(parsedNumber) && parsedNumber > 0

  function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed || !isValidNumber) return
    startTransition(async () => {
      const result = await createAdminHead({ headNumber: parsedNumber, name: trimmed })
      if (result.ok) {
        toast.success('Admin head added.')
        setHeadNumber('')
        setName('')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-admin-head-table:add' })
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
          value={headNumber}
          onChange={(e) => setHeadNumber(e.target.value)}
          placeholder="No."
          disabled={isPending}
          className="h-8 w-20"
        />
      </TableCell>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New admin head name"
          disabled={isPending}
          className="h-8 w-72"
        />
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <Button size="sm" variant="outline" disabled={!name.trim() || !isValidNumber || isPending} onClick={handleAdd}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
