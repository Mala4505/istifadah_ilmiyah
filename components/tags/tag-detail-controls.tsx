'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link2, Trash2, Unlink, X } from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import { EntryPicker } from '@/components/tags/entry-picker'
import { ScopeAddRow } from '@/components/tags/scope-picks'
import { useTagAction } from '@/components/tags/use-tag-action'
import {
  addTagScope,
  deleteTag,
  removeTagScope,
  saveTagEventNote,
  unlinkEntryFromTag,
} from '@/lib/actions/tags'
import { linkEntriesInBatches } from '@/components/tags/tag-batches'
import { linkedEntriesMessage } from '@/lib/tags/entries-shared'
import { TAG_NOTE_MAX, type DepartmentRef, type SubDepartmentRef } from '@/lib/tags/shared'
import type { Event } from '@/lib/events/types'

/** Delete the whole tag (confirmation first). The entries and departments themselves are untouched. */
export function DeleteTagButton({ tagId, tagName }: { tagId: number; tagName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const { pending, run } = useTagAction('tags.delete')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="text-destructive hover:text-destructive">
          <Trash2 className="h-4 w-4" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this tag?</DialogTitle>
          <DialogDescription>
            &quot;{tagName}&quot; will be removed along with its departments, yearly notes and entry links. The entries
            themselves are not changed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              run(() => deleteTag({ tagId }), {
                success: 'Tag deleted.',
                failureTitle: 'Could not delete the tag.',
                onSuccess: () => {
                  setOpen(false)
                  router.push('/tags')
                },
              })
            }
          >
            {pending ? 'Deleting…' : 'Delete tag'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Remove one department / sub-department row, by hand or from a linked entry. A row that came
 * from an entry can return if the entry is linked again or its sub-department is set again.
 */
export function RemoveScopeButton({
  tagId,
  scopeId,
  label,
  fromEntry = false,
}: {
  tagId: number
  scopeId: number
  label: string
  fromEntry?: boolean
}) {
  const { pending, run } = useTagAction('tags.remove-scope')
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      disabled={pending}
      title={
        fromEntry
          ? 'Remove this row. It may come back if the entry is linked again or its sub-department is set again.'
          : 'Remove this row'
      }
      aria-label={`Remove ${label} from this tag`}
      onClick={() =>
        run(() => removeTagScope({ tagId, scopeId }), {
          success: 'Department removed.',
          failureTitle: 'Could not remove the department.',
        })
      }
    >
      <X className="h-4 w-4" />
    </Button>
  )
}

/** Add a department (+ optional sub-department) to an existing tag; saved immediately. */
export function AddScopeControl({
  tagId,
  departments,
  subDepartments,
}: {
  tagId: number
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
}) {
  const { pending, run } = useTagAction('tags.add-scope')
  return (
    <ScopeAddRow
      departments={departments}
      subDepartments={subDepartments}
      disabled={pending}
      onAdd={(pick) =>
        run(() => addTagScope({ tagId, departmentId: pick.departmentId, subDepartmentId: pick.subDepartmentId }), {
          success: 'Department added.',
          failureTitle: 'Could not add the department.',
        })
      }
    />
  )
}

/** Unlink one entry. Its department stays on the tag -- the table's caption says so. */
export function UnlinkEntryButton({ tagId, entryId, ubbl }: { tagId: number; entryId: number; ubbl: string }) {
  const { pending, run } = useTagAction('tags.unlink')
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 gap-1 px-2 text-xs"
      disabled={pending}
      aria-label={`Unlink entry ${ubbl} from this tag`}
      onClick={() =>
        run(() => unlinkEntryFromTag({ tagId, entryId }), {
          success: 'Entry unlinked. Its department stays on the tag.',
          failureTitle: 'Could not unlink the entry.',
        })
      }
    >
      <Unlink className="h-3.5 w-3.5" />
      Unlink
    </Button>
  )
}

/** The one free-text note a tag can have for an event. Saving an empty note clears it. */
export function EventNoteEditor({
  tagId,
  eventId,
  initialNote,
  hijriYear,
}: {
  tagId: number
  eventId: number
  initialNote: string
  hijriYear: string
}) {
  const [note, setNote] = useState(initialNote)
  const { pending, run } = useTagAction('tags.event-note')
  const dirty = note.trim() !== initialNote.trim()

  return (
    <div className="flex min-w-64 items-start gap-2">
      <Textarea
        aria-label={`Note for ${hijriYear}`}
        rows={2}
        className="min-h-0 text-sm"
        value={note}
        maxLength={TAG_NOTE_MAX}
        placeholder="e.g. 12 tents torn"
        disabled={pending}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending || !dirty}
        onClick={() =>
          run(() => saveTagEventNote({ tagId, eventId, note }), {
            success: note.trim() ? 'Note saved.' : 'Note cleared.',
            failureTitle: 'Could not save the note.',
          })
        }
      >
        Save
      </Button>
    </div>
  )
}

/** "Link entries" button + dialog on the tag page. */
export function LinkEntriesDialog({
  tagId,
  events,
  departments,
  subDepartments,
  defaultEventId,
}: {
  tagId: number
  events: Event[]
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  defaultEventId: number | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [entryIds, setEntryIds] = useState<number[]>([])

  /** Every way out of the dialog (Cancel, the X, Escape, a click outside) drops the selection. */
  function handleOpenChange(next: boolean) {
    if (!next) setEntryIds([])
    setOpen(next)
  }

  async function handleLink() {
    if (entryIds.length === 0) {
      toast.error('Pick at least one entry.')
      return
    }
    setPending(true)
    try {
      const result = await linkEntriesInBatches(tagId, entryIds)
      if (!result.ok) {
        toastError(result.error, { context: 'tags.link-dialog', title: 'Could not link the entries.' })
        // Earlier batches may already have gone through; show them.
        if (result.linked > 0) router.refresh()
        return
      }
      toast.success(linkedEntriesMessage(result.linked, new Set(entryIds).size))
      handleOpenChange(false)
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        context: 'tags.link-dialog',
        title: 'Could not link the entries.',
      })
    } finally {
      setPending(false)
    }
  }

  const linkLabel =
    entryIds.length === 0 ? 'Link' : `Link ${entryIds.length} ${entryIds.length === 1 ? 'entry' : 'entries'}`

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Link2 className="h-4 w-4" />
          Link entries
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Link entries</DialogTitle>
          <DialogDescription>
            Each entry&apos;s department and sub-department are added to the tag. If an entry is older than the start
            event, the start event moves back to it.
          </DialogDescription>
        </DialogHeader>
        <EntryPicker
          events={events}
          departments={departments}
          subDepartments={subDepartments}
          defaultEventId={defaultEventId}
          tagId={tagId}
          selectedIds={entryIds}
          onSelectedChange={setEntryIds}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleLink} disabled={pending || entryIds.length === 0}>
            {pending ? 'Linking…' : linkLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
