'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { updateBudgetHeadMapping } from '@/lib/actions/admin'
import { useTableControls, type ControlColumn } from '@/components/ui/table-controls'

export type BudgetHeadRow = {
  id: number
  rawLabel: string
  shortLabel: string | null
  departmentId: number | null
  departmentName: string | null
  headId: number | null
}

export type HeadOption = {
  id: number
  headNumber: number
  name: string
}

const UNMAPPED_VALUE = 'unmapped'

function headIdToValue(headId: number | null): string {
  return headId === null ? UNMAPPED_VALUE : String(headId)
}

function valueToHeadId(value: string): number | null {
  return value === UNMAPPED_VALUE ? null : Number(value)
}

export function BudgetHeadTable({
  budgetHeads,
  heads,
}: {
  budgetHeads: BudgetHeadRow[]
  heads: HeadOption[]
}) {
  const headLabel = new Map(heads.map((h) => [h.id, `${h.headNumber}. ${h.name}`]))
  const columns: ControlColumn<BudgetHeadRow>[] = [
    { key: 'raw', label: 'Raw label', value: (b) => b.rawLabel, filter: false },
    { key: 'short', label: 'Short label', value: (b) => b.shortLabel, filter: false },
    { key: 'department', label: 'Department', value: (b) => b.departmentName },
    {
      key: 'head',
      label: 'Mapped head',
      value: (b) => (b.headId === null ? 'Unmapped' : headLabel.get(b.headId) ?? 'Unmapped'),
    },
  ]
  const controls = useTableControls(budgetHeads, {
    columns,
    searchPlaceholder: 'Search budget heads…',
    noun: 'budget head',
  })
  return (
    <div className="flex flex-col gap-2">
      {controls.toolbar}
      <Table>
        <TableHeader>
          <TableRow>
            {controls.header('raw')}
            {controls.header('short')}
            {controls.header('department')}
            {controls.header('head')}
            <TableHead className="text-right">Save</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {controls.pageItems.map((budgetHead) => (
            <BudgetHeadRowItem key={budgetHead.id} budgetHead={budgetHead} heads={heads} />
          ))}
        </TableBody>
      </Table>
      {controls.pagination}
    </div>
  )
}

function BudgetHeadRowItem({ budgetHead, heads }: { budgetHead: BudgetHeadRow; heads: HeadOption[] }) {
  const [headId, setHeadId] = useState(budgetHead.headId)
  const [isPending, startTransition] = useTransition()

  const isDirty = headId !== budgetHead.headId

  // Admin heads stopped being department-scoped (20260913000001) -- they're
  // org-wide now, so every budget head can map to any of them regardless of
  // its own department_id.
  const options = heads

  function handleSave() {
    startTransition(async () => {
      const result = await updateBudgetHeadMapping({ budgetHeadId: budgetHead.id, headId })
      if (result.ok) {
        toast.success('Budget head mapping updated.')
      } else {
        toastError(result.error, { context: 'budget-head-table' })
      }
    })
  }

  return (
    <TableRow>
      <TableCell>{budgetHead.rawLabel}</TableCell>
      <TableCell>{budgetHead.shortLabel ?? '—'}</TableCell>
      <TableCell>{budgetHead.departmentName ?? '—'}</TableCell>
      <TableCell>
        <Select value={headIdToValue(headId)} onValueChange={(value) => setHeadId(valueToHeadId(value))}>
          <SelectTrigger className="w-[240px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNMAPPED_VALUE}>Unmapped</SelectItem>
            {options.map((head) => (
              <SelectItem key={head.id} value={String(head.id)}>
                {`${head.headNumber}. ${head.name}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!isDirty || isPending} onClick={handleSave}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
