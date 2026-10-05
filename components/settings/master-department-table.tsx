'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { createDepartment, updateDepartment } from '@/lib/actions/admin'
import { useTableControls, type ControlColumn } from '@/components/ui/table-controls'
import type { DepartmentOption } from '@/lib/settings/shape'

export type MasterDepartmentRow = DepartmentOption & { isActive: boolean }

const DEPARTMENT_COLUMNS: ControlColumn<MasterDepartmentRow>[] = [
  { key: 'name', label: 'Name', value: (d) => d.name },
  { key: 'active', label: 'Active', value: (d) => d.isActive },
]

export function MasterDepartmentTable({ departments }: { departments: MasterDepartmentRow[] }) {
  const controls = useTableControls(departments, {
    columns: DEPARTMENT_COLUMNS,
    initialSort: { key: 'name', direction: 'asc' },
    searchPlaceholder: 'Search departments…',
    noun: 'department',
  })
  return (
    <div className="flex flex-col gap-2">
      {controls.toolbar}
      <Table>
        <TableHeader>
          <TableRow>
            {controls.header('name')}
            {controls.header('active', { className: 'w-[90px]' })}
            <TableHead className="text-right">Save</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {controls.pageItems.map((department) => (
            <DepartmentRowItem key={department.id} department={department} />
          ))}
          <NewDepartmentRow />
        </TableBody>
      </Table>
      {controls.pagination}
    </div>
  )
}

function DepartmentRowItem({ department }: { department: MasterDepartmentRow }) {
  const router = useRouter()
  const [name, setName] = useState(department.name)
  const [isActive, setIsActive] = useState(department.isActive)
  const [isPending, startTransition] = useTransition()

  const isDirty = name !== department.name || isActive !== department.isActive

  function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await updateDepartment({ id: department.id, name: trimmed, isActive })
      if (result.ok) {
        toast.success('Department updated.')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-department-table' })
      }
    })
  }

  return (
    <TableRow>
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

function NewDepartmentRow() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await createDepartment({ name: trimmed })
      if (result.ok) {
        toast.success('Department added.')
        setName('')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-department-table:add' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New department name"
          disabled={isPending}
          className="h-8 w-64"
        />
      </TableCell>
      <TableCell />
      <TableCell className="text-right">
        <Button size="sm" variant="outline" disabled={!name.trim() || isPending} onClick={handleAdd}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
