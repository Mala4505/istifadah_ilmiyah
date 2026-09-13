'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { createSubDepartment, updateSubDepartment } from '@/lib/actions/admin'
import type { SubDepartmentRow } from '@/lib/settings/shape'

export type DepartmentChoice = { id: number; name: string }

/**
 * Grouped by department instead of one flat table with a department picker
 * on every row (2026-09-13 feedback: too long, and a per-row department
 * dropdown wasn't wanted). Each department is its own native `<details>`,
 * same pattern the original read-only master-data page used -- expand a
 * department to rename/deactivate/add its sub-departments. Reassigning a
 * sub-department to a different department isn't offered here (it's
 * inherently grouped by its current one); that'd need a separate move
 * action if it's ever wanted.
 */
export function MasterSubDepartmentTable({
  subDepartments,
  departments,
}: {
  subDepartments: SubDepartmentRow[]
  departments: DepartmentChoice[]
}) {
  return (
    <div className="flex flex-col gap-2">
      {departments.map((department) => {
        const rows = subDepartments.filter((row) => row.departmentId === department.id)
        return (
          <details key={department.id} className="rounded-md border border-border px-3 py-2">
            <summary className="cursor-pointer marker:text-muted-foreground">
              <span className="ml-1 inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm font-semibold">{department.name}</span>
                <span className="text-xs text-muted-foreground">
                  {rows.length} sub-department{rows.length === 1 ? '' : 's'}
                </span>
              </span>
            </summary>
            <div className="mt-3">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="w-[90px]">Active</TableHead>
                    <TableHead className="text-right">Save</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <SubDepartmentRowItem key={row.id} row={row} />
                  ))}
                  <NewSubDepartmentRow departmentId={department.id} />
                </TableBody>
              </Table>
            </div>
          </details>
        )
      })}
    </div>
  )
}

function SubDepartmentRowItem({ row }: { row: SubDepartmentRow }) {
  const router = useRouter()
  const [name, setName] = useState(row.name)
  const [isActive, setIsActive] = useState(row.isActive)
  const [isPending, startTransition] = useTransition()

  const isDirty = name !== row.name || isActive !== row.isActive

  function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await updateSubDepartment({
        id: row.id,
        departmentId: row.departmentId,
        name: trimmed,
        isActive,
      })
      if (result.ok) {
        toast.success('Sub-department updated.')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-sub-department-table' })
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

function NewSubDepartmentRow({ departmentId }: { departmentId: number }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleAdd() {
    const trimmed = name.trim()
    if (!trimmed) return
    startTransition(async () => {
      const result = await createSubDepartment({ departmentId, name: trimmed })
      if (result.ok) {
        toast.success('Sub-department added.')
        setName('')
        router.refresh()
      } else {
        toastError(result.error, { context: 'master-sub-department-table:add' })
      }
    })
  }

  return (
    <TableRow>
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
        <Button size="sm" variant="outline" disabled={!name.trim() || isPending} onClick={handleAdd}>
          {isPending ? 'Adding…' : 'Add'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
