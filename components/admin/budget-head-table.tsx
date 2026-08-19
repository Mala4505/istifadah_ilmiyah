'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { updateBudgetHeadMapping } from '@/lib/actions/admin'

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
  departmentId: number
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
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Raw label</TableHead>
          <TableHead>Short label</TableHead>
          <TableHead>Department</TableHead>
          <TableHead>Mapped head</TableHead>
          <TableHead className="text-right">Save</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {budgetHeads.map((budgetHead) => (
          <BudgetHeadRowItem key={budgetHead.id} budgetHead={budgetHead} heads={heads} />
        ))}
      </TableBody>
    </Table>
  )
}

function BudgetHeadRowItem({ budgetHead, heads }: { budgetHead: BudgetHeadRow; heads: HeadOption[] }) {
  const [headId, setHeadId] = useState(budgetHead.headId)
  const [isPending, startTransition] = useTransition()

  const isDirty = headId !== budgetHead.headId

  const options = useMemo(() => {
    if (budgetHead.departmentId === null) return heads
    return heads.filter((head) => head.departmentId === budgetHead.departmentId)
  }, [heads, budgetHead.departmentId])

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
