'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTableControls, type ControlColumn } from '@/components/ui/table-controls'
import { formatINR, formatNumber } from '@/lib/reports/format'
import {
  mergeItemCatalog,
  moveItemCatalogFamily,
  renameItemCatalog,
  setItemCatalogConfirmed,
} from '@/lib/actions/item-catalog'
import { itemOptionLabel, type ItemCatalogRow, type ItemFamilyOption } from '@/lib/settings/item-catalog-shape'
import { PickList, type PickOption } from './item-catalog-pick-list'

const CONTEXT = 'item-catalog-table'

/**
 * Catalog items as a table (master data renders as tables, never lists):
 * label, family, category, line count, value, sample descriptions, confirmed.
 * Actions per row: confirm / un-confirm, rename (inline), move to another
 * family, merge into another item. Bulk-confirm the ticked rows. Defaults to
 * "Needs confirmation" -- the work queue -- with a toggle to see everything.
 */
export function ItemCatalogTable({
  items,
  families,
}: {
  items: ItemCatalogRow[]
  families: ItemFamilyOption[]
}) {
  const [rows, setRows] = useState(items)
  const [unconfirmedOnly, setUnconfirmedOnly] = useState(() => items.some((i) => !i.isConfirmed))
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [moveItem, setMoveItem] = useState<ItemCatalogRow | null>(null)
  const [mergeItem, setMergeItem] = useState<ItemCatalogRow | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    setRows(items)
  }, [items])

  const unconfirmedCount = useMemo(() => rows.filter((r) => !r.isConfirmed).length, [rows])

  const scoped = useMemo(
    () => (unconfirmedOnly ? rows.filter((r) => !r.isConfirmed) : rows),
    [rows, unconfirmedOnly],
  )

  const columns = useMemo<ControlColumn<ItemCatalogRow>[]>(
    () => [
      { key: 'label', label: 'Item', value: (r) => r.label, filter: false },
      { key: 'family', label: 'Family', value: (r) => r.familyLabel ?? 'No family' },
      { key: 'category', label: 'Category', value: (r) => r.category ?? 'No category' },
      { key: 'lines', label: 'Lines', value: (r) => r.lineCount, descendingFirst: true, searchable: false },
      {
        key: 'value',
        label: 'Pre-tax value',
        value: (r) => r.pretaxValue,
        descendingFirst: true,
        searchable: false,
      },
      {
        key: 'samples',
        label: 'Sample descriptions',
        value: (r) => r.sampleDescriptions.join(' · '),
        filter: false,
        sortable: false,
      },
      { key: 'confirmed', label: 'Confirmed', value: (r) => r.isConfirmed, searchable: false },
    ],
    [],
  )

  const controls = useTableControls(scoped, {
    columns,
    initialSort: { key: 'lines', direction: 'desc' },
    searchPlaceholder: 'Search items, families, descriptions…',
    noun: 'item',
    toolbarExtra: (
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={unconfirmedOnly}
          onCheckedChange={(v) => {
            setUnconfirmedOnly(v === true)
            setSelected(new Set())
          }}
          aria-label="Show only items that need confirmation"
        />
        Needs confirmation only ({formatNumber(unconfirmedCount)})
      </label>
    ),
  })

  const pageIds = controls.pageItems.map((r) => r.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((rowId) => selected.has(rowId))

  function toggleRow(rowId: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(rowId)
      else next.delete(rowId)
      return next
    })
  }

  function togglePage(on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const rowId of pageIds) {
        if (on) next.add(rowId)
        else next.delete(rowId)
      }
      return next
    })
  }

  function applyConfirmed(itemIds: number[], confirmed: boolean) {
    if (itemIds.length === 0) return
    const idSet = new Set(itemIds)
    const previous = rows
    setRows((current) => current.map((r) => (idSet.has(r.id) ? { ...r, isConfirmed: confirmed } : r)))
    setSelected(new Set())
    startTransition(async () => {
      const result = await setItemCatalogConfirmed({ itemIds, confirmed })
      if (!result.ok) {
        setRows(previous)
        toastError(result.error, { context: CONTEXT, title: 'Could not update confirmation' })
        return
      }
      toast.success(
        confirmed
          ? `Confirmed ${formatNumber(itemIds.length)} item${itemIds.length === 1 ? '' : 's'}.`
          : 'Marked as unconfirmed.',
      )
    })
  }

  function startEditing(row: ItemCatalogRow) {
    setEditingId(row.id)
    setDraftLabel(row.label)
  }

  function cancelEditing() {
    setEditingId(null)
    setDraftLabel('')
  }

  function saveRename(row: ItemCatalogRow) {
    const next = draftLabel.trim()
    if (!next || next === row.label) {
      cancelEditing()
      return
    }
    startTransition(async () => {
      const result = await renameItemCatalog({ itemId: row.id, label: next })
      if (!result.ok) {
        toastError(result.error, { context: CONTEXT, title: 'Could not rename the item' })
        return
      }
      setRows((current) => current.map((r) => (r.id === row.id ? { ...r, label: next } : r)))
      toast.success(`Renamed to "${next}".`)
      cancelEditing()
    })
  }

  const selectedIds = Array.from(selected)

  return (
    <div className="space-y-3">
      {controls.toolbar}
      {selectedIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span>{formatNumber(selectedIds.length)} selected</span>
          <Button size="sm" onClick={() => applyConfirmed(selectedIds, true)} disabled={isPending}>
            Confirm selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={isPending}>
            Clear selection
          </Button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <Checkbox
                  checked={allPageSelected}
                  onCheckedChange={(v) => togglePage(v === true)}
                  aria-label="Select every item on this page"
                />
              </TableHead>
              {controls.header('label')}
              {controls.header('family')}
              {controls.header('category')}
              {controls.header('lines', { align: 'right' })}
              {controls.header('value', { align: 'right' })}
              {controls.header('samples')}
              {controls.header('confirmed')}
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {controls.pageItems.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-muted-foreground">
                  {unconfirmedOnly && !controls.filtered
                    ? 'Every catalog item is confirmed.'
                    : 'No items match these filters.'}
                </TableCell>
              </TableRow>
            ) : (
              controls.pageItems.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(v) => toggleRow(row.id, v === true)}
                      aria-label={`Select ${row.label}`}
                    />
                  </TableCell>
                  <TableCell className="min-w-[14rem]">
                    {editingId === row.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={draftLabel}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') saveRename(row)
                            if (event.key === 'Escape') cancelEditing()
                          }}
                          disabled={isPending}
                          autoFocus
                          className="h-8"
                          aria-label={`New name for ${row.label}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => saveRename(row)}
                          disabled={isPending}
                          aria-label="Save name"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={cancelEditing}
                          disabled={isPending}
                          aria-label="Cancel rename"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="group flex items-center gap-1.5">
                        <span className="flex flex-col">
                          <span>{row.label}</span>
                          {!row.isComparable ? (
                            <span className="text-xs text-muted-foreground">Lump sum -- excluded from rate comparisons</span>
                          ) : null}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => startEditing(row)}
                          aria-label={`Rename ${row.label}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{row.familyLabel ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{row.category ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(row.lineCount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(row.pretaxValue)}</TableCell>
                  <TableCell className="max-w-[22rem]">
                    {row.sampleDescriptions.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                        {row.sampleDescriptions.map((s) => (
                          <span key={s} className="truncate" title={s}>
                            {s}
                          </span>
                        ))}
                        {row.aliasCount > row.sampleDescriptions.length ? (
                          <span>+{formatNumber(row.aliasCount - row.sampleDescriptions.length)} more spellings</span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {row.isConfirmed ? (
                      <Badge variant="secondary">Confirmed</Badge>
                    ) : (
                      <span className="text-muted-foreground">Not yet</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1.5">
                      {row.isConfirmed ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => applyConfirmed([row.id], false)}
                          disabled={isPending}
                        >
                          Unconfirm
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => applyConfirmed([row.id], true)} disabled={isPending}>
                          Confirm
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setMoveItem(row)} disabled={isPending}>
                        Move…
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setMergeItem(row)} disabled={isPending}>
                        Merge…
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
      <MoveFamilyDialog
        item={moveItem}
        families={families}
        onClose={() => setMoveItem(null)}
        onMoved={(itemId, family) =>
          setRows((current) =>
            current.map((r) =>
              r.id === itemId ? { ...r, familyId: family.id, familyLabel: family.label, category: family.category } : r,
            ),
          )
        }
      />
      <MergeItemDialog
        item={mergeItem}
        items={rows}
        onClose={() => setMergeItem(null)}
        onMerged={(sourceId) => {
          setRows((current) => current.filter((r) => r.id !== sourceId))
          setSelected((prev) => {
            const next = new Set(prev)
            next.delete(sourceId)
            return next
          })
        }}
      />
    </div>
  )
}

function MoveFamilyDialog({
  item,
  families,
  onClose,
  onMoved,
}: {
  item: ItemCatalogRow | null
  families: ItemFamilyOption[]
  onClose: () => void
  onMoved: (itemId: number, family: ItemFamilyOption) => void
}) {
  const [familyId, setFamilyId] = useState<number | null>(null)
  const [isPending, startTransition] = useTransition()

  const options = useMemo<PickOption[]>(
    () =>
      families
        .filter((f) => f.id !== item?.familyId)
        .map((f) => ({ id: f.id, label: f.label, hint: f.category })),
    [families, item?.familyId],
  )

  function close() {
    setFamilyId(null)
    onClose()
  }

  function submit() {
    if (!item || familyId === null) return
    const family = families.find((f) => f.id === familyId)
    if (!family) return
    startTransition(async () => {
      const result = await moveItemCatalogFamily({ itemId: item.id, familyId })
      if (!result.ok) {
        toastError(result.error, { context: CONTEXT, title: 'Could not move the item' })
        return
      }
      onMoved(item.id, family)
      toast.success(`Moved "${item.label}" to ${family.label}.`)
      close()
    })
  }

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move &quot;{item?.label}&quot; to another family</DialogTitle>
          <DialogDescription>
            Currently in {item?.familyLabel ?? 'no family'}. Its {formatNumber(item?.lineCount ?? 0)} bill line
            {item?.lineCount === 1 ? '' : 's'} move with it, so family-level rate comparisons and spend charts
            pick up the change.
          </DialogDescription>
        </DialogHeader>
        <PickList options={options} value={familyId} onChange={setFamilyId} placeholder="Search families…" />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={isPending || familyId === null}>
            {isPending ? 'Moving…' : 'Move item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function MergeItemDialog({
  item,
  items,
  onClose,
  onMerged,
}: {
  item: ItemCatalogRow | null
  items: ItemCatalogRow[]
  onClose: () => void
  onMerged: (sourceId: number) => void
}) {
  const [targetId, setTargetId] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Same family first: that is where near-duplicates live.
  const options = useMemo<PickOption[]>(() => {
    if (!item) return []
    return items
      .filter((r) => r.id !== item.id)
      .toSorted(
        (a, b) =>
          Number(b.familyId === item.familyId) - Number(a.familyId === item.familyId) ||
          a.label.localeCompare(b.label),
      )
      .map((r) => ({
        id: r.id,
        label: itemOptionLabel(r),
        hint: `${r.category ?? 'No category'} · ${formatNumber(r.lineCount)} lines${r.isConfirmed ? ' · confirmed' : ''}`,
      }))
  }, [item, items])

  const target = items.find((r) => r.id === targetId) ?? null

  function close() {
    setTargetId(null)
    setConfirming(false)
    onClose()
  }

  function submit() {
    if (!item || !target) return
    startTransition(async () => {
      const result = await mergeItemCatalog({ sourceItemId: item.id, targetItemId: target.id })
      if (!result.ok) {
        toastError(result.error, { context: CONTEXT, title: 'Could not merge the items' })
        return
      }
      onMerged(item.id)
      toast.success(`Merged "${item.label}" into "${target.label}".`)
      close()
    })
  }

  return (
    <Dialog open={item !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent>
        {confirming && target ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Merge &quot;{item?.label}&quot; into &quot;{target.label}&quot;?
              </DialogTitle>
              <DialogDescription>
                All {formatNumber(item?.aliasCount ?? 0)} spelling{item?.aliasCount === 1 ? '' : 's'} and{' '}
                {formatNumber(item?.lineCount ?? 0)} bill line{item?.lineCount === 1 ? '' : 's'} move to &quot;
                {target.label}&quot; and take its family. &quot;{item?.label}&quot; is then deleted. This cannot
                be undone in one click -- the moved descriptions would have to be re-assigned one by one.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
                Back
              </Button>
              <Button type="button" variant="destructive" onClick={submit} disabled={isPending}>
                {isPending ? 'Merging…' : 'Confirm merge'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Merge &quot;{item?.label}&quot; into…</DialogTitle>
              <DialogDescription>Items in the same family are listed first.</DialogDescription>
            </DialogHeader>
            <PickList options={options} value={targetId} onChange={setTargetId} placeholder="Search catalog items…" />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button type="button" onClick={() => setConfirming(true)} disabled={target === null}>
                Continue
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
