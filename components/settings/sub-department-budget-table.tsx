'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { updateSubDepartmentBudget } from '@/lib/actions/admin'

export type SubDepartmentBudgetRow = {
  id: number
  departmentName: string
  name: string
  budgetAmount: number | null
}

export function SubDepartmentBudgetTable({ rows }: { rows: SubDepartmentBudgetRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Department</TableHead>
          <TableHead>Sub-department</TableHead>
          <TableHead className="w-[180px]">Budget amount</TableHead>
          <TableHead className="text-right">Save</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <SubDepartmentBudgetRowItem key={row.id} row={row} />
        ))}
      </TableBody>
    </Table>
  )
}

function SubDepartmentBudgetRowItem({ row }: { row: SubDepartmentBudgetRow }) {
  const initialValue = row.budgetAmount === null ? '' : String(row.budgetAmount)
  const [value, setValue] = useState(initialValue)
  const [isPending, startTransition] = useTransition()

  const trimmed = value.trim()
  const parsedAmount = trimmed === '' ? null : Number(trimmed)
  const isValid = trimmed === '' || (Number.isFinite(parsedAmount) && parsedAmount! >= 0)
  const isDirty = value !== initialValue

  function handleSave() {
    if (!isValid) return
    startTransition(async () => {
      const result = await updateSubDepartmentBudget({ subDepartmentId: row.id, budgetAmount: parsedAmount })
      if (result.ok) {
        toast.success('Budget updated.')
      } else {
        toastError(result.error, { context: 'sub-department-budget-table' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>{row.departmentName}</TableCell>
      <TableCell>{row.name}</TableCell>
      <TableCell>
        <Input
          type="number"
          inputMode="decimal"
          min={0}
          step="0.01"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={isPending}
          className="h-8 w-40"
        />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!isDirty || !isValid || isPending} onClick={handleSave}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
