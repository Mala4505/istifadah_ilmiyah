'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Pencil, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectNative } from '@/components/ui/select-native'
import { Textarea } from '@/components/ui/textarea'
import { EntryPicker } from '@/components/tags/entry-picker'
import { ScopePicksEditor } from '@/components/tags/scope-picks'
import { updateTag } from '@/lib/actions/tags'
import { createTagInBatches } from '@/components/tags/tag-batches'
import {
  TAG_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  eventLabel,
  sortEventsAscending,
  type DepartmentRef,
  type ScopePick,
  type SubDepartmentRef,
} from '@/lib/tags/shared'
import type { StartEventWarning } from '@/lib/tags/start-event'
import type { Event } from '@/lib/events/types'

export interface TagFieldValues {
  name: string
  description: string
  startEventId: number | null
  endEventId: number | null
}

/** Name, description and period -- the fields create and edit have in common. */
export function TagFields({
  events,
  values,
  onChange,
  disabled,
}: {
  events: Event[]
  values: TagFieldValues
  onChange: (next: TagFieldValues) => void
  disabled: boolean
}) {
  const eventsNewestFirst = useMemo(() => sortEventsAscending(events).reverse(), [events])

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="tag-name">Name</Label>
        <Input
          id="tag-name"
          value={values.name}
          maxLength={TAG_NAME_MAX}
          disabled={disabled}
          placeholder="e.g. Washroom block"
          onChange={(e) => onChange({ ...values, name: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="tag-description">Description (optional)</Label>
        <Textarea
          id="tag-description"
          rows={3}
          value={values.description}
          maxLength={TAG_DESCRIPTION_MAX}
          disabled={disabled}
          placeholder="What was built or bought, and what it needs each year."
          onChange={(e) => onChange({ ...values, description: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tag-start-event">Start event</Label>
        <SelectNative
          id="tag-start-event"
          value={values.startEventId === null ? '' : String(values.startEventId)}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, startEventId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Pick an event</option>
          {eventsNewestFirst.map((event) => (
            <option key={event.id} value={event.id}>
              {eventLabel(event)}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tag-end-event">End event</Label>
        <SelectNative
          id="tag-end-event"
          value={values.endEventId === null ? '' : String(values.endEventId)}
          disabled={disabled}
          onChange={(e) => onChange({ ...values, endEventId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Perpetual (no end)</option>
          {eventsNewestFirst.map((event) => (
            <option key={event.id} value={event.id}>
              {eventLabel(event)}
            </option>
          ))}
        </SelectNative>
      </div>
    </div>
  )
}

/** "New tag" button + dialog: name, period, departments, and (optionally) entries to link. */
export function CreateTagDialog({
  events,
  departments,
  subDepartments,
  defaultEventId,
}: {
  events: Event[]
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  /** The selected event: the default start event and where the entry picker opens. */
  defaultEventId: number | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [values, setValues] = useState<TagFieldValues>({
    name: '',
    description: '',
    startEventId: defaultEventId,
    endEventId: null,
  })
  const [scope, setScope] = useState<ScopePick[]>([])
  const [entryIds, setEntryIds] = useState<number[]>([])

  function reset() {
    setValues({ name: '', description: '', startEventId: defaultEventId, endEventId: null })
    setScope([])
    setEntryIds([])
  }

  async function handleSubmit() {
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
      const result = await createTagInBatches(
        {
          name: values.name,
          description: values.description.trim() || null,
          startEventId: values.startEventId,
          endEventId: values.endEventId,
          scope,
        },
        entryIds
      )
      if (!result.ok) {
        toastError(result.error, { context: 'tags.create-dialog', title: 'Could not create the tag.' })
        return
      }
      if (result.entryError) toastError(result.entryError, { context: 'tags.create-dialog' })
      toast.success('Tag created.')
      setOpen(false)
      reset()
      router.push(`/tags/${result.tagId}`)
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        context: 'tags.create-dialog',
        title: 'Could not create the tag.',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New tag
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New tag</DialogTitle>
          <DialogDescription>
            A tag records something an event&apos;s spending left behind, so later events can see it already exists.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <TagFields events={events} values={values} onChange={setValues} disabled={pending} />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Departments</h3>
            <p className="text-xs text-muted-foreground">
              At least one department is required. Linking an entry below adds that entry&apos;s department and
              sub-department automatically.
            </p>
            <ScopePicksEditor
              departments={departments}
              subDepartments={subDepartments}
              picks={scope}
              onChange={setScope}
            />
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Link entries (optional)</h3>
            <p className="text-xs text-muted-foreground">
              Start with the current event, or switch to an earlier one to tag older entries. If an entry is older than
              the start event, the start event moves back to it.
            </p>
            <EntryPicker
              events={events}
              departments={departments}
              subDepartments={subDepartments}
              defaultEventId={defaultEventId}
              tagId={null}
              selectedIds={entryIds}
              onSelectedChange={setEntryIds}
            />
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? 'Creating…' : 'Create tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** "Edit" button + dialog for the details and period of an existing tag. */
export function EditTagDialog({
  tag,
  events,
}: {
  tag: { id: number; name: string; description: string | null; startEventId: number; endEventId: number | null }
  events: Event[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const initial: TagFieldValues = {
    name: tag.name,
    description: tag.description ?? '',
    startEventId: tag.startEventId,
    endEventId: tag.endEventId,
  }
  const [values, setValuesState] = useState<TagFieldValues>(initial)
  // Set when the server says the start event is later than a linked entry's event. Cleared as
  // soon as any field changes, so "Save anyway" always confirms what is on screen.
  const [warning, setWarning] = useState<StartEventWarning | null>(null)

  function setValues(next: TagFieldValues) {
    setWarning(null)
    setValuesState(next)
  }

  async function handleSubmit(confirmStartAfterEntries = false) {
    if (!values.name.trim()) {
      toast.error('Give the tag a name.')
      return
    }
    if (values.startEventId === null) {
      toast.error('Pick the start event.')
      return
    }
    setPending(true)
    try {
      const result = await updateTag({
        tagId: tag.id,
        name: values.name,
        description: values.description.trim() || null,
        startEventId: values.startEventId,
        endEventId: values.endEventId,
        confirmStartAfterEntries,
      })
      if (!result.ok) {
        if ('startEventWarning' in result) {
          setWarning(result.startEventWarning)
          return
        }
        toastError(result.error, { context: 'tags.edit-dialog', title: 'Could not save the tag.' })
        return
      }
      toast.success('Tag saved.')
      setOpen(false)
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        context: 'tags.edit-dialog',
        title: 'Could not save the tag.',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Re-seed from the saved tag each time it opens, so a cancelled edit leaves no residue.
        if (next) {
          setValuesState(initial)
          setWarning(null)
        }
        setOpen(next)
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline">
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit tag</DialogTitle>
          <DialogDescription>
            Departments, linked entries and yearly notes are managed on the tag page itself.
          </DialogDescription>
        </DialogHeader>
        <TagFields events={events} values={values} onChange={setValues} disabled={pending} />
        {warning ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <p>{warning.message}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          {warning ? (
            <Button onClick={() => handleSubmit(true)} disabled={pending}>
              {pending ? 'Saving…' : 'Save anyway'}
            </Button>
          ) : (
            <Button onClick={() => handleSubmit()} disabled={pending}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
