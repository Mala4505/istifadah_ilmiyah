'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { updateSubDepartmentBudget } from '@/lib/actions/admin'
import { useTableControls, type ControlColumn } from '@/components/ui/table-controls'

export type SubDepartmentBudgetRow = {
  id: number
  departmentName: string
  name: string
  budgetAmount: number | null
}

const BUDGET_COLUMNS: ControlColumn<SubDepartmentBudgetRow>[] = [
  { key: 'department', label: 'Department', value: (r) => r.departmentName },
  { key: 'name', label: 'Sub-department', value: (r) => r.name },
  { key: 'amount', label: 'Budget amount', value: (r) => r.budgetAmount, descendingFirst: true },
]

export function SubDepartmentBudgetTable({ rows }: { rows: SubDepartmentBudgetRow[] }) {
  const controls = useTableControls(rows, {
    columns: BUDGET_COLUMNS,
    searchPlaceholder: 'Search sub-departments…',
    noun: 'sub-department',
  })
  return (
    <div className="flex flex-col gap-2">
      {controls.toolbar}
      <Table>
        <TableHeader>
          <TableRow>
            {controls.header('department')}
            {controls.header('name')}
            {controls.header('amount', { className: 'w-[180px]' })}
            <TableHead className="text-right">Save</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {controls.pageItems.map((row) => (
            <SubDepartmentBudgetRowItem key={row.id} row={row} />
          ))}
        </TableBody>
      </Table>
      {controls.pagination}
    </div>
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
