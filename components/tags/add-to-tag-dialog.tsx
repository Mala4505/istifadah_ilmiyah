'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ScopePicksEditor } from '@/components/tags/scope-picks'
import { TagFields, type TagFieldValues } from '@/components/tags/tag-form-dialog'
import {
  createTagInBatches,
  linkEntriesInBatches,
  loadAddToTagOptionsInBatches,
} from '@/components/tags/tag-batches'
import {
  addedToTagMessage,
  rankTagsForDepartments,
  type AddToTagOptions,
} from '@/lib/tags/entries-shared'
import type { ScopePick } from '@/lib/tags/shared'

type Mode = 'existing' | 'new'

/**
 * "Add to tag" for one or many entries (super-admin only; the buttons that open it are
 * hidden from everyone else and every action behind it is gated again). Pick an existing tag
 * or create one inline. Linking adds each entry's department / sub-department to the tag in
 * the database, so nothing here touches scope except the departments of a brand-new tag.
 *
 * Follows components/entries/bulk-void-dialog.tsx: open/onOpenChange from the caller, an
 * `onDone` that the caller uses to clear its selection and reload.
 */
export function AddToTagDialog({
  open,
  onOpenChange,
  entryIds,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entryIds: number[]
  onDone: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add to tag</DialogTitle>
          <DialogDescription>
            Applies to {entryIds.length.toLocaleString('en-IN')} selected{' '}
            {entryIds.length === 1 ? 'entry' : 'entries'}. Their departments are added to the tag automatically.
            Voided entries can be tagged too — they stay marked as voided and are left out of the cost.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open (Radix unmounts closed content), so each opening starts fresh. */}
        <AddToTagLoader entryIds={entryIds} onClose={() => onOpenChange(false)} onDone={onDone} />
      </DialogContent>
    </Dialog>
  )
}

function AddToTagLoader({
  entryIds,
  onClose,
  onDone,
}: {
  entryIds: number[]
  onClose: () => void
  onDone: () => void
}) {
  const [options, setOptions] = useState<AddToTagOptions | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let ignore = false
    loadAddToTagOptionsInBatches(entryIds)
      .then((result) => {
        if (ignore) return
        if (result.ok) setOptions(result.options)
        else setLoadError(result.error)
      })
      .catch((err: unknown) => {
        if (ignore) return
        toastError(err instanceof Error ? err.message : null, { context: 'add-to-tag.load' })
        setLoadError('Could not load the tags. Close this and try again.')
      })
    return () => {
      ignore = true
    }
    // Opened once per mount with this selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (loadError) {
    return (
      <div className="flex flex-col gap-3">
        <FriendlyError message={loadError} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </div>
    )
  }
  if (!options) return <p className="py-8 text-center text-sm text-muted-foreground">Loading tags…</p>
  return <AddToTagForm options={options} entryIds={entryIds} onClose={onClose} onDone={onDone} />
}

function AddToTagForm({
  options,
  entryIds,
  onClose,
  onDone,
}: {
  options: AddToTagOptions
  entryIds: number[]
  onClose: () => void
  onDone: () => void
}) {
  const [mode, setMode] = useState<Mode>(options.tags.length > 0 ? 'existing' : 'new')
  const [pending, setPending] = useState(false)

  // existing tag
  const [tagId, setTagId] = useState<number | null>(null)
  const [filter, setFilter] = useState('')

  // new tag
  const [values, setValues] = useState<TagFieldValues>({
    name: '',
    description: '',
    startEventId: options.defaultStartEventId,
    endEventId: null,
  })
  const [scope, setScope] = useState<ScopePick[]>(options.defaultScope)

  const departmentName = useMemo(
    () => new Map(options.departments.map((d) => [d.id, d.name])),
    [options.departments]
  )
  const ranked = useMemo(
    () =>
      rankTagsForDepartments(
        options.tags,
        options.defaultScope.map((p) => p.departmentId)
      ),
    [options.tags, options.defaultScope]
  )
  const visibleTags = useMemo(() => {
    const term = filter.trim().toLowerCase()
    return term ? ranked.filter((t) => t.name.toLowerCase().includes(term)) : ranked
  }, [ranked, filter])

  async function handleSubmit() {
    if (mode === 'existing') {
      const tag = options.tags.find((t) => t.id === tagId)
      if (!tag) {
        toast.error('Pick a tag first.')
        return
      }
      setPending(true)
      try {
        const result = await linkEntriesInBatches(tag.id, entryIds)
        if (!result.ok) {
          toastError(result.error, { context: 'add-to-tag.link', title: 'Could not add to the tag.' })
          // Earlier batches may already have gone through; let the screen catch up.
          if (result.linked > 0) onDone()
          return
        }
        toast.success(addedToTagMessage(result.linked, tag.name, new Set(entryIds).size))
        onClose()
        onDone()
      } catch (err) {
        toastError(err instanceof Error ? err.message : null, {
          context: 'add-to-tag.link',
          title: 'Could not add to the tag.',
        })
      } finally {
        setPending(false)
      }
      return
    }

    if (!values.name.trim()) {
      toast.error('Give the tag a name.')
      return
    }
    if (values.startEventId === null) {
      toast.error('Pick the start event.')
      return
    }
    if (scope.length === 0) {
      toast.error('Add at least one department.')
      return
    }
    setPending(true)
    try {
      const created = await createTagInBatches(
        {
          name: values.name,
          description: values.description.trim() || null,
          startEventId: values.startEventId,
          endEventId: values.endEventId,
          scope,
        },
        entryIds
      )
      if (!created.ok) {
        toastError(created.error, { context: 'add-to-tag.create', title: 'Could not create the tag.' })
        return
      }
      if (created.entryError) {
        toastError(created.entryError, { context: 'add-to-tag.create' })
        onClose()
        onDone()
        return
      }
      toast.success(
        <span>
          Created tag &quot;{values.name.trim()}&quot; and added {created.linked.toLocaleString('en-IN')}{' '}
          {created.linked === 1 ? 'entry' : 'entries'}.{' '}
          <Link href={`/tags/${created.tagId}`} className="underline">
            Open tag
          </Link>
        </span>
      )
      onClose()
      onDone()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        context: 'add-to-tag.create',
        title: 'Could not create the tag.',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Which tag">
          <Button
            type="button"
            size="sm"
            variant={mode === 'existing' ? 'default' : 'outline'}
            aria-pressed={mode === 'existing'}
            disabled={pending || options.tags.length === 0}
            onClick={() => setMode('existing')}
          >
            Existing tag
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === 'new' ? 'default' : 'outline'}
            aria-pressed={mode === 'new'}
            disabled={pending}
            onClick={() => setMode('new')}
          >
            New tag
          </Button>
        </div>

        {mode === 'existing' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-to-tag-filter">Find a tag</Label>
              <Input
                id="add-to-tag-filter"
                value={filter}
                placeholder="Type part of the name"
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
            <div className="max-h-72 overflow-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>Tag</TableHead>
                    <TableHead>Period</TableHead>
                    <TableHead>Departments</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleTags.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                        No tag matches that name.
                      </TableCell>
                    </TableRow>
                  ) : (
                    visibleTags.map((tag) => (
                      <TableRow
                        key={tag.id}
                        data-state={tagId === tag.id ? 'selected' : undefined}
                        className="cursor-pointer"
                        onClick={() => setTagId(tag.id)}
                      >
                        <TableCell>
                          <input
                            type="radio"
                            name="add-to-tag-choice"
                            checked={tagId === tag.id}
                            onChange={() => setTagId(tag.id)}
                            aria-label={`Choose ${tag.name}`}
                            className="h-4 w-4 accent-primary"
                          />
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">{tag.name}</span>
                          {tag.matches && (
                            <Badge variant="secondary" className="ml-2">
                              Same department
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{tag.periodLabel}</TableCell>
                        <TableCell>
                          {tag.departmentIds.map((id) => departmentName.get(id) ?? 'Unknown').join(', ') || '—'}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <TagFields events={options.events} values={values} onChange={setValues} disabled={pending} />
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Departments</h3>
              <p className="text-xs text-muted-foreground">
                At least one department is required. Filled in from the selected{' '}
                {entryIds.length === 1 ? 'entry' : 'entries'}; change them if the tag belongs elsewhere.
              </p>
              <ScopePicksEditor
                departments={options.departments}
                subDepartments={options.subDepartments}
                picks={scope}
                onChange={setScope}
              />
            </section>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={pending || (mode === 'existing' && tagId === null)}>
          {pending ? 'Saving…' : mode === 'existing' ? 'Add to tag' : 'Create tag and add'}
        </Button>
      </DialogFooter>
    </>
  )
}
