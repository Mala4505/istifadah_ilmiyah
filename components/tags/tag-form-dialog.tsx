'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Check, Pencil, Plus } from 'lucide-react'
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
import { updateTag } from '@/lib/actions/tags'
import { createTagInBatches } from '@/components/tags/tag-batches'
import { cn } from '@/lib/utils'
import {
  createButtonLabel,
  entriesSelectedLabel,
  firstInvalidField,
  validateDetailsStep,
  type DetailsErrors,
  type DetailsField,
  type NewTagStep,
} from '@/lib/tags/new-tag-steps'
import {
  TAG_DESCRIPTION_MAX,
  TAG_NAME_MAX,
  eventLabel,
  sortEventsAscending,
  type DepartmentRef,
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

/** Plain-English problem text per field, shown under it. Optional: Edit and Add-to-tag omit it. */
export interface TagFieldErrors {
  name?: string
  startEventId?: string
  endEventId?: string
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs text-destructive">
      {message}
    </p>
  )
}

/**
 * Name, description and period -- the fields create and edit have in common. `errors`,
 * `descriptionRows` and `className` are optional so the existing callers (Edit, Add-to-tag)
 * render exactly as before.
 */
export function TagFields({
  events,
  values,
  onChange,
  disabled,
  errors,
  descriptionRows = 3,
  className,
}: {
  events: Event[]
  values: TagFieldValues
  onChange: (next: TagFieldValues) => void
  disabled: boolean
  errors?: TagFieldErrors
  descriptionRows?: number
  className?: string
}) {
  const eventsNewestFirst = useMemo(() => sortEventsAscending(events).reverse(), [events])

  return (
    <div className={cn('grid grid-cols-1 gap-3 sm:grid-cols-2', className)}>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="tag-name">Name</Label>
        <Input
          id="tag-name"
          value={values.name}
          maxLength={TAG_NAME_MAX}
          disabled={disabled}
          placeholder="e.g. Washroom block"
          aria-invalid={errors?.name ? true : undefined}
          aria-describedby={errors?.name ? 'tag-name-error' : undefined}
          onChange={(e) => onChange({ ...values, name: e.target.value })}
        />
        <FieldError id="tag-name-error" message={errors?.name} />
      </div>
      <div className="flex flex-col gap-1.5 sm:col-span-2">
        <Label htmlFor="tag-description">Description (optional)</Label>
        <Textarea
          id="tag-description"
          rows={descriptionRows}
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
          aria-invalid={errors?.startEventId ? true : undefined}
          aria-describedby={errors?.startEventId ? 'tag-start-event-error' : undefined}
          onChange={(e) => onChange({ ...values, startEventId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Pick an event</option>
          {eventsNewestFirst.map((event) => (
            <option key={event.id} value={event.id}>
              {eventLabel(event)}
            </option>
          ))}
        </SelectNative>
        <FieldError id="tag-start-event-error" message={errors?.startEventId} />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tag-end-event">End event</Label>
        <SelectNative
          id="tag-end-event"
          value={values.endEventId === null ? '' : String(values.endEventId)}
          disabled={disabled}
          aria-invalid={errors?.endEventId ? true : undefined}
          aria-describedby={errors?.endEventId ? 'tag-end-event-error' : undefined}
          onChange={(e) => onChange({ ...values, endEventId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">Perpetual (no end)</option>
          {eventsNewestFirst.map((event) => (
            <option key={event.id} value={event.id}>
              {eventLabel(event)}
            </option>
          ))}
        </SelectNative>
        <FieldError id="tag-end-event-error" message={errors?.endEventId} />
      </div>
    </div>
  )
}

/** The id of the element that should take focus for a step-1 field with an error. */
function focusTargetId(field: DetailsField): string {
  switch (field) {
    case 'name':
      return 'tag-name'
    case 'startEventId':
      return 'tag-start-event'
    case 'endEventId':
      return 'tag-end-event'
  }
}

/** "1 Details -- 2 Entries": the current step is highlighted, a finished step shows a check. */
function StepIndicator({ step }: { step: NewTagStep }) {
  const steps: Array<{ key: NewTagStep; number: number; label: string }> = [
    { key: 'details', number: 1, label: 'Details' },
    { key: 'entries', number: 2, label: 'Entries' },
  ]
  return (
    <ol className="flex items-center justify-center gap-4 pt-1 text-sm sm:gap-6" aria-label="Steps">
      {steps.map((item, index) => {
        const current = item.key === step
        const done = item.key === 'details' && step === 'entries'
        return (
          <li
            key={item.key}
            aria-current={current ? 'step' : undefined}
            className={cn('flex items-center gap-2', current ? 'font-medium text-foreground' : 'text-muted-foreground')}
          >
            <span
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs',
                current && 'border-primary bg-primary text-primary-foreground',
                done && 'border-primary bg-primary/10 text-primary'
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : item.number}
            </span>
            <span>
              {item.label}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
            {index < steps.length - 1 ? (
              // A thin line between the steps; the gap around it keeps them well apart (3rem+ from sm up).
              <span aria-hidden className="ml-4 h-px w-6 bg-border sm:ml-6 sm:w-12" />
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * "New tag" button + two-step dialog. Step 1 "Details": name, description and period.
 * Departments are not asked for: they come from the linked entries. Step 2 "Add entries (optional)": the bills to link. Header and
 * footer stay pinned and the body scrolls, so the dialog keeps one size across both steps.
 */
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
  const bodyRef = useRef<HTMLDivElement>(null)
  const entriesHeadingRef = useRef<HTMLHeadingElement>(null)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [step, setStep] = useState<NewTagStep>('details')
  // The entry picker is only mounted once step 2 has been reached (so opening the dialog does
  // not search for entries), then kept mounted so Back and Next keep its filters.
  const [entriesReached, setEntriesReached] = useState(false)
  // After a failed Next, problems are shown and re-checked live as the person fixes them.
  const [attempted, setAttempted] = useState(false)
  const [values, setValues] = useState<TagFieldValues>({
    name: '',
    description: '',
    startEventId: defaultEventId,
    endEventId: null,
  })
  const [entryIds, setEntryIds] = useState<number[]>([])

  function reset() {
    setValues({ name: '', description: '', startEventId: defaultEventId, endEventId: null })
    setEntryIds([])
    setStep('details')
    setEntriesReached(false)
    setAttempted(false)
  }

  function handleOpenChange(next: boolean) {
    // Esc, the overlay and Cancel all land here. Not while the tag is being saved.
    if (pending) return
    reset()
    setOpen(next)
  }

  const errors: DetailsErrors = attempted ? validateDetailsStep(values, events) : {}

  // On a step change, scroll the body back to the top and put focus somewhere sensible.
  useEffect(() => {
    if (!open) return
    bodyRef.current?.scrollTo({ top: 0 })
    if (step === 'entries') entriesHeadingRef.current?.focus()
    else document.getElementById('tag-name')?.focus()
  }, [step, open])

  /** Checks step 1. True when fine; otherwise shows the problems and focuses the first one. */
  function checkDetails(): boolean {
    const found = validateDetailsStep(values, events)
    const first = firstInvalidField(found)
    if (first === null) return true
    setAttempted(true)
    setStep('details')
    const targetId = focusTargetId(first)
    requestAnimationFrame(() => document.getElementById(targetId)?.focus())
    return false
  }

  function handleNext() {
    if (!checkDetails()) return
    setEntriesReached(true)
    setStep('entries')
  }

  async function handleCreate() {
    if (!checkDetails() || values.startEventId === null) return
    setPending(true)
    try {
      const result = await createTagInBatches(
        {
          name: values.name,
          description: values.description.trim() || null,
          startEventId: values.startEventId,
          endEventId: values.endEventId,
          // No departments are picked here: each linked entry adds its own, and a super-admin can
          // add more on the tag page.
          scope: [],
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

  const onEntriesStep = step === 'entries'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4" />
          New tag
        </Button>
      </DialogTrigger>
      <DialogContent className="flex h-[90vh] max-h-[40rem] max-w-3xl flex-col gap-0 p-0">
        <DialogHeader className="gap-2 border-b px-6 pb-4 pr-12 pt-6">
          <DialogTitle>New tag</DialogTitle>
          <DialogDescription>
            A tag records something an event&apos;s spending left behind, so later events can see it already exists.
          </DialogDescription>
          <StepIndicator step={step} />
        </DialogHeader>

        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <form
            id="new-tag-details-form"
            noValidate
            className={cn('flex flex-col gap-5', onEntriesStep && 'hidden')}
            onSubmit={(e) => {
              e.preventDefault()
              handleNext()
            }}
          >
            <TagFields
              events={events}
              values={values}
              onChange={setValues}
              disabled={pending}
              errors={errors}
              descriptionRows={2}
              className="gap-4"
            />
          </form>

          {entriesReached ? (
            <div className={cn('flex flex-col gap-4', !onEntriesStep && 'hidden')}>
              <div className="flex flex-col gap-1">
                <h3 ref={entriesHeadingRef} tabIndex={-1} className="text-sm font-medium outline-none">
                  Add entries (optional)
                </h3>
                <p className="text-sm text-muted-foreground">
                  Link the bills that paid for it. Skip this if you are adding it from memory. Their departments are added to the tag automatically.
                </p>
              </div>
              <EntryPicker
                events={events}
                departments={departments}
                subDepartments={subDepartments}
                defaultEventId={defaultEventId}
                tagId={null}
                selectedIds={entryIds}
                onSelectedChange={setEntryIds}
              />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          {onEntriesStep ? (
            <p className="text-sm font-medium" aria-live="polite">
              {entriesSelectedLabel(entryIds.length)}
            </p>
          ) : (
            <span />
          )}
          <DialogFooter className="gap-2 sm:space-x-0">
            {onEntriesStep ? (
              <>
                <Button type="button" variant="outline" onClick={() => setStep('details')} disabled={pending}>
                  Back
                </Button>
                <Button type="button" onClick={handleCreate} disabled={pending}>
                  {pending ? 'Creating…' : createButtonLabel(entryIds.length)}
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" form="new-tag-details-form">
                  Next
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
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
