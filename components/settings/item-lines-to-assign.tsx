'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTableControls, type ControlColumn } from '@/components/ui/table-controls'
import { formatINR, formatNumber } from '@/lib/reports/format'
import { assignItemDescription, createItemCatalog } from '@/lib/actions/item-catalog'
import {
  LINE_ASSIGN_REASON_LABEL,
  itemOptionLabel,
  type ItemCatalogRow,
  type ItemFamilyOption,
  type LineToAssignRow,
} from '@/lib/settings/item-catalog-shape'
import { PickList, type PickOption } from './item-catalog-pick-list'

const CONTEXT = 'item-lines-to-assign'

/**
 * The to-assign queue: bill-line descriptions with no catalog match, or a
 * match the rules were unsure of (size not read / low LLM confidence). Each
 * row is one distinct description, with how many bill lines carry it.
 * "Assign…" attaches it to an existing item (or a new one in a family);
 * "Keep" confirms the current match as-is.
 */
export function ItemLinesToAssign({
  lines,
  items,
  families,
}: {
  lines: LineToAssignRow[]
  items: ItemCatalogRow[]
  families: ItemFamilyOption[]
}) {
  const [rows, setRows] = useState(lines)
  const [assigning, setAssigning] = useState<LineToAssignRow | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    setRows(lines)
  }, [lines])

  const columns = useMemo<ControlColumn<LineToAssignRow>[]>(
    () => [
      { key: 'reason', label: 'Why', value: (r) => LINE_ASSIGN_REASON_LABEL[r.reason] },
      { key: 'description', label: 'Bill description', value: (r) => r.rawDescription, filter: false },
      {
        key: 'current',
        label: 'Currently on',
        value: (r) => (r.currentItemLabel ? r.currentItemLabel : null),
        filter: false,
      },
      { key: 'unit', label: 'Unit', value: (r) => r.unit },
      { key: 'lines', label: 'Lines', value: (r) => r.lineCount, descendingFirst: true, searchable: false },
      { key: 'vendors', label: 'Vendors', value: (r) => r.vendorCount, descendingFirst: true, searchable: false },
      { key: 'value', label: 'Pre-tax value', value: (r) => r.pretaxValue, descendingFirst: true, searchable: false },
    ],
    [],
  )

  const controls = useTableControls(rows, {
    columns,
    initialSort: { key: 'lines', direction: 'desc' },
    searchPlaceholder: 'Search descriptions…',
    noun: 'description',
  })

  function removeRow(key: string) {
    setRows((current) => current.filter((r) => r.key !== key))
  }

  function keep(row: LineToAssignRow) {
    if (row.currentItemId === null) return
    const itemId = row.currentItemId
    startTransition(async () => {
      const result = await assignItemDescription({ rawDescription: row.rawDescription, itemId })
      if (!result.ok) {
        toastError(result.error, { context: CONTEXT, title: 'Could not confirm the match' })
        return
      }
      removeRow(row.key)
      toast.success(`Kept on "${row.currentItemLabel}".`)
    })
  }

  return (
    <div className="space-y-3">
      {controls.toolbar}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {controls.header('reason')}
              {controls.header('description')}
              {controls.header('current')}
              {controls.header('unit')}
              {controls.header('lines', { align: 'right' })}
              {controls.header('vendors', { align: 'right' })}
              {controls.header('value', { align: 'right' })}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {controls.pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                  {controls.filtered ? 'No descriptions match these filters.' : 'Every bill line is on a catalog item.'}
                </TableCell>
              </TableRow>
            ) : (
              controls.pageItems.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <Badge variant={row.reason === 'unmatched' ? 'outline' : 'secondary'}>
                      {LINE_ASSIGN_REASON_LABEL[row.reason]}
                    </Badge>
                    {row.confidence !== null ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {Math.round(row.confidence * 100)}%
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-[24rem] break-words">{row.rawDescription}</TableCell>
                  <TableCell className="max-w-[16rem]">
                    {row.currentItemLabel ? (
                      <span className="text-sm">{row.currentItemLabel}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>{row.unit ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.lineCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.vendorCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(row.pretaxValue)}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      {row.currentItemId !== null ? (
                        <Button variant="ghost" size="sm" onClick={() => keep(row)} disabled={isPending}>
                          Keep
                        </Button>
                      ) : null}
                      <Button variant="outline" size="sm" onClick={() => setAssigning(row)} disabled={isPending}>
                        Assign…
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {controls.pagination}
      <AssignDialog
        line={assigning}
        items={items}
        families={families}
        onClose={() => setAssigning(null)}
        onAssigned={(key) => removeRow(key)}
      />
    </div>
  )
}

function AssignDialog({
  line,
  items,
  families,
  onClose,
  onAssigned,
}: {
  line: LineToAssignRow | null
  items: ItemCatalogRow[]
  families: ItemFamilyOption[]
  onClose: () => void
  onAssigned: (key: string) => void
}) {
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [itemId, setItemId] = useState<number | null>(null)
  const [familyId, setFamilyId] = useState<number | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [isPending, startTransition] = useTransition()

  const itemOptions = useMemo<PickOption[]>(
    () =>
      items
        .filter((r) => r.id !== line?.currentItemId)
        .map((r) => ({
          id: r.id,
          label: itemOptionLabel(r),
          hint: `${r.category ?? 'No category'}${r.unit ? ` · per ${r.unit}` : ''} · ${formatNumber(r.lineCount)} lines`,
        })),
    [items, line?.currentItemId],
  )

  const familyOptions = useMemo<PickOption[]>(
    () => families.map((f) => ({ id: f.id, label: f.label, hint: f.category })),
    [families],
  )

  function close() {
    setMode('existing')
    setItemId(null)
    setFamilyId(null)
    setNewLabel('')
    onClose()
  }

  function submit() {
    if (!line) return
    startTransition(async () => {
      if (mode === 'existing') {
        if (itemId === null) return
        const result = await assignItemDescription({ rawDescription: line.rawDescription, itemId })
        if (!result.ok) {
          toastError(result.error, { context: CONTEXT, title: 'Could not assign the line' })
          return
        }
        const target = items.find((r) => r.id === itemId)
        toast.success(`Assigned to "${target?.label ?? 'the selected item'}".`)
      } else {
        if (familyId === null || !newLabel.trim()) return
        const result = await createItemCatalog({
          familyId,
          label: newLabel.trim(),
          rawDescription: line.rawDescription,
        })
        if (!result.ok) {
          toastError(result.error, { context: CONTEXT, title: 'Could not create the item' })
          return
        }
        toast.success(`Created "${newLabel.trim()}" and assigned the line to it.`)
      }
      onAssigned(line.key)
      close()
    })
  }

  const canSubmit = mode === 'existing' ? itemId !== null : familyId !== null && newLabel.trim().length > 0

  return (
    <Dialog open={line !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign a bill description</DialogTitle>
          <DialogDescription className="break-words">
            &quot;{line?.rawDescription}&quot; -- {formatNumber(line?.lineCount ?? 0)} bill line
            {line?.lineCount === 1 ? '' : 's'}. Every line with this exact wording (ignoring case and spacing)
            moves to the item you pick, and future bills spelled the same way attach automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1.5" role="tablist">
          <Button
            type="button"
            size="sm"
            variant={mode === 'existing' ? 'secondary' : 'ghost'}
            onClick={() => setMode('existing')}
            role="tab"
            aria-selected={mode === 'existing'}
          >
            Existing item
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'new' ? 'secondary' : 'ghost'}
            onClick={() => setMode('new')}
            role="tab"
            aria-selected={mode === 'new'}
          >
            New item in a family
          </Button>
        </div>
        {mode === 'existing' ? (
          <PickList options={itemOptions} value={itemId} onChange={setItemId} placeholder="Search catalog items…" />
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-item-label">New item name</Label>
              <Input
                id="new-item-label"
                value={newLabel}
                onChange={(event) => setNewLabel(event.target.value)}
                placeholder="e.g. CPVC elbow · 3in"
              />
            </div>
            <PickList options={familyOptions} value={familyId} onChange={setFamilyId} placeholder="Search families…" />
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={isPending || !canSubmit}>
            {isPending ? 'Saving…' : mode === 'existing' ? 'Assign' : 'Create and assign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
