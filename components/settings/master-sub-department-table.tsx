'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { createSubDepartment, updateSubDepartment } from '@/lib/actions/admin'
import type { SubDepartmentRow } from '@/lib/settings/shape'

export type DepartmentChoice = { id: number; name: string }

export function MasterSubDepartmentTable({
  subDepartments,
  departments,
}: {
  subDepartments: SubDepartmentRow[]
  departments: DepartmentChoice[]
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Department</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-[90px]">Active</TableHead>
          <TableHead className="text-right">Save</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {subDepartments.map((row) => (
          <SubDepartmentRowItem key={row.id} row={row} departments={departments} />
        ))}
        <NewSubDepartmentRow departments={departments} />
      </TableBody>
    </Table>
  )
}

function SubDepartmentRowItem({ row, departments }: { row: SubDepartmentRow; departments: DepartmentChoice[] }) {
  const [departmentId, setDepartmentId] = useState(row.departmentId)
  const [name, setName] = useState(row.name)
  const [isActive, setIsActive] = useState(row.isActive)
  const [isPending, startTransition] = useTransition()

  const isDirty = departmentId !== row.departmentId || name !== row.name || isActive !== row.isActive

  function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await updateSubDepartment({ id: row.id, departmentId, name: trimmed, isActive })
      if (result.ok) {
        toast.success('Sub-department updated.')
      } else {
        toastError(result.error, { context: 'master-sub-department-table' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>
        <Select value={String(departmentId)} onValueChange={(v) => setDepartmentId(Number(v))}>
          <SelectTrigger className="h-8 w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={String(d.id)}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={isPending} className="h-8 w-64" />
      </TableCell>
      <TableCell>
        <Checkbox checked={isActive} onCheckedChange={(v) => setIsActive(v === true)} disabled={isPending} />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!isDirty || !name.trim() || isPending} onClick={handleSave}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  )
}

function NewSubDepartmentRow({ departments }: { departments: DepartmentChoice[] }) {
  const [departmentId, setDepartmentId] = useState<number | null>(departments[0]?.id ?? null)
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed || departmentId === null) return
    startTransition(async () => {
      const result = await createSubDepartment({ departmentId, name: trimmed })
      if (result.ok) {
        toast.success('Sub-department added.')
        setName('')
      } else {
        toastError(result.error, { context: 'master-sub-department-table:add' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>
        <Select
          value={departmentId === null ? undefined : String(departmentId)}
          onValueChange={(v) => setDepartmentId(Number(v))}
        >
          <SelectTrigger className="h-8 w-48">
            <SelectValue placeholder="Department" />
          </SelectTrigger>
          <SelectContent>
            {departments.map((d) => (
              <SelectItem key={d.id} value={String(d.id)}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New sub-department name"
          disabled={isPending}
          className="h-8 w-64"
        />
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <Button size="sm" variant="outline" disabled={!name.trim() || departmentId === null || isPending} onClick={handleAdd}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
