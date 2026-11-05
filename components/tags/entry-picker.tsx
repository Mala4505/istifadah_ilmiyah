'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectNative } from '@/components/ui/select-native'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatMoney } from '@/components/entries/format'
import { searchEntriesForTag, type PickerEntry } from '@/lib/actions/tags'
import { eventLabel, sortEventsAscending, type DepartmentRef, type SubDepartmentRef } from '@/lib/tags/shared'
import type { Event } from '@/lib/events/types'

/**
 * Picks entries to link to a tag. Opens on `defaultEventId` (the current event) and can be
 * switched to an earlier event to tag older entries; filterable by department,
 * sub-department and a typed term. The selection survives changing the filters. Linking
 * adds each entry's department/sub-department to the tag in the database -- nothing here
 * duplicates that.
 */
export function EntryPicker({
  events,
  departments,
  subDepartments,
  defaultEventId,
  tagId,
  selectedIds,
  onSelectedChange,
}: {
  events: Event[]
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  defaultEventId: number | null
  /** The tag being edited, so entries already on it are shown as linked. Null while creating. */
  tagId: number | null
  selectedIds: number[]
  onSelectedChange: (ids: number[]) => void
}) {
  const eventsNewestFirst = useMemo(() => sortEventsAscending(events).reverse(), [events])
  const [eventId, setEventId] = useState<number | null>(defaultEventId ?? eventsNewestFirst[0]?.id ?? null)
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [subDepartmentId, setSubDepartmentId] = useState<number | null>(null)
  const [draftSearch, setDraftSearch] = useState('')
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<PickerEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)

  const subOptions = useMemo(
    () => (departmentId === null ? [] : subDepartments.filter((s) => s.departmentId === departmentId)),
    [subDepartments, departmentId]
  )

  useEffect(() => {
    if (eventId === null) return
    let ignore = false
    setLoading(true)
    searchEntriesForTag({ eventId, departmentId, subDepartmentId, search, tagId })
      .then((result) => {
        if (ignore) return
        if (!result.ok) {
          toastError(result.error, { context: 'tags.entry-picker', title: 'Could not load entries.' })
          setEntries([])
          setTruncated(false)
          return
        }
        setEntries(result.entries)
        setTruncated(result.truncated)
      })
      .catch((err: unknown) => {
        if (ignore) return
        toastError(err instanceof Error ? err.message : null, {
          context: 'tags.entry-picker',
          title: 'Could not load entries.',
        })
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [eventId, departmentId, subDepartmentId, search, tagId])

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  function toggle(entryId: number, checked: boolean) {
    onSelectedChange(checked ? [...selectedIds, entryId] : selectedIds.filter((x) => x !== entryId))
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="picker-event">Event</Label>
          <SelectNative
            id="picker-event"
            value={eventId === null ? '' : String(eventId)}
            onChange={(e) => setEventId(Number(e.target.value))}
          >
            {eventsNewestFirst.map((event) => (
              <option key={event.id} value={event.id}>
                {eventLabel(event)}
                {event.isCurrent ? ' — current' : ''}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="picker-department">Department</Label>
          <SelectNative
            id="picker-department"
            value={departmentId === null ? '' : String(departmentId)}
            onChange={(e) => {
              setDepartmentId(e.target.value ? Number(e.target.value) : null)
              setSubDepartmentId(null)
            }}
          >
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </SelectNative>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="picker-sub-department">Sub-department</Label>
          <SelectNative
            id="picker-sub-department"
            value={subDepartmentId === null ? '' : String(subDepartmentId)}
            disabled={subOptions.length === 0}
            onChange={(e) => setSubDepartmentId(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{departmentId === null ? 'Pick a department first' : 'All sub-departments'}</option>
            {subOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </SelectNative>
        </div>
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            setSearch(draftSearch.trim())
          }}
        >
          <Label htmlFor="picker-search">Search</Label>
          <div className="flex gap-2">
            <Input
              id="picker-search"
              value={draftSearch}
              onChange={(e) => setDraftSearch(e.target.value)}
              placeholder="UBBL no., invoice no. or vendor"
            />
            <Button type="submit" variant="outline" size="icon" aria-label="Search entries">
              <Search className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>

      <div className="max-h-72 overflow-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>UBBL no.</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Vendor</TableHead>
              <TableHead>Department</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  {loading ? 'Loading entries…' : 'No entries match these filters.'}
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <TableRow key={entry.id} data-state={selected.has(entry.id) ? 'selected' : undefined}>
                  <TableCell>
                    <Checkbox
                      aria-label={`Select entry ${entry.ubblNumber}`}
                      checked={entry.alreadyLinked || selected.has(entry.id)}
                      disabled={entry.alreadyLinked}
                      onCheckedChange={(checked) => toggle(entry.id, checked === true)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.ubblNumber}
                    {entry.alreadyLinked && <span className="ml-2 text-muted-foreground">(already linked)</span>}
                  </TableCell>
                  <TableCell>{formatDate(entry.date)}</TableCell>
                  <TableCell className="max-w-48 truncate">{entry.vendor ?? '—'}</TableCell>
                  <TableCell>
                    {entry.departmentName ?? '—'}
                    {entry.subDepartmentName ? ` › ${entry.subDepartmentName}` : ''}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(entry.amount)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {selectedIds.length} selected
        {truncated ? ' · showing the latest 100 — narrow the filters to find others' : ''}
      </p>
    </div>
  )
}
