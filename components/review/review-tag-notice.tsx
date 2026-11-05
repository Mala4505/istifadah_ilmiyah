'use client'

/**
 * Entry tags on the review screen (docs/entry-tags-plan.md, Phase 4). The ONE place the
 * review screen mentions tags -- rendered once, under the Verify/Connect/Classify status
 * line, never repeated per step (no-duplicate-status rule). It lists the tags active in the
 * selected event that touch ANY department of ANY entry linked to this bill (a tag appears
 * once however many entries match), with each tag's note for this event, as a small table.
 *
 * "Linked" is per entry. Super-admins get a "Link" button per tag (linkEntriesToTag,
 * unchanged); on a bill with several entries a small select next to it picks WHICH entry to
 * link, starting on the entry whose department the tag covers. With one entry there is no
 * select. The database trigger adds the entry's department / sub-department to the tag, so
 * nothing here touches scope. Everyone else sees the notice read-only.
 *
 * Linking never calls router.refresh(): the review form may hold unsaved edits, and the
 * link changes nothing else on this screen, so the row flips to "Linked" from local state
 * instead. The workspace keys this component on the bill's entries, so that local state
 * resets when the reviewer moves to a bill with different entries.
 */

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { SelectNative } from '@/components/ui/select-native'
import { FriendlyError } from '@/components/ui/friendly-error'
import { toastError } from '@/components/ui/error-toast'
import { linkEntriesToTag } from '@/lib/actions/tags'
import { formatINR } from '@/lib/reports/format'
import {
  defaultLinkEntryId,
  orderReviewTagRows,
  reviewTagCoverageLabel,
  reviewTagNoticeHeading,
  tagRowMatchesEntry,
  unlinkedEntriesForTag,
  type ReviewNoticeEntry,
  type ReviewTagNoticeData,
  type ReviewTagRow,
} from '@/lib/tags/review-shared'

export function ReviewTagNotice({
  notice,
  primaryEntryId,
  subDepartmentId,
  canLink,
}: {
  notice: ReviewTagNoticeData
  /** The entry the Classify step edits (the bill's largest). */
  primaryEntryId: number
  /** The live Classify-step pick for the primary entry (null = none yet) -- only reorders rows, never hides them. */
  subDepartmentId: number | null
  canLink: boolean
}) {
  const [open, setOpen] = useState(true)
  // "tagId:entryId" pairs linked during this session (the server's own links are on the rows).
  const [linkedNow, setLinkedNow] = useState<ReadonlySet<string>>(() => new Set())
  // The entry the reviewer picked in a row's select; absent = the row's default.
  const [choice, setChoice] = useState<Readonly<Record<number, number>>>({})
  const [pendingTagId, setPendingTagId] = useState<number | null>(null)
  const [isPending, startTransition] = useTransition()

  const { entries, departments } = notice
  const multiEntry = entries.length > 1
  const multiDepartment = departments.length > 1
  const departmentNameById = useMemo(() => new Map(departments.map((d) => [d.id, d.name])), [departments])

  // The Classify pick belongs to the primary entry; the other entries keep their saved sub-department.
  const liveEntries = useMemo(
    () => entries.map((e) => (e.entryId === primaryEntryId ? { ...e, subDepartmentId } : e)),
    [entries, primaryEntryId, subDepartmentId]
  )
  const rows = useMemo(() => orderReviewTagRows(notice.rows, liveEntries), [notice.rows, liveEntries])

  if (notice.error) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-2 py-1.5">
        <FriendlyError message={notice.error} className="text-xs" />
      </div>
    )
  }
  if (rows.length === 0) return null

  function linkedIdsFor(row: ReviewTagRow): Set<number> {
    const ids = new Set(row.linkedEntryIds)
    for (const e of entries) if (linkedNow.has(`${row.tagId}:${e.entryId}`)) ids.add(e.entryId)
    return ids
  }

  function handleLink(tagId: number, tagName: string, entry: ReviewNoticeEntry) {
    setPendingTagId(tagId)
    startTransition(async () => {
      try {
        const result = await linkEntriesToTag({ tagId, entryIds: [entry.entryId] })
        if (!result.ok) {
          toastError(result.error, { context: 'review-tag-notice', title: 'Could not link the entry to the tag.' })
          return
        }
        setLinkedNow((prev) => new Set(prev).add(`${tagId}:${entry.entryId}`))
        toast.success(multiEntry ? `${entry.ubblNumber} linked to "${tagName}".` : `Entry linked to "${tagName}".`)
      } catch (err) {
        toastError(err instanceof Error ? err.message : null, {
          context: 'review-tag-notice',
          title: 'Could not link the entry to the tag.',
        })
      } finally {
        setPendingTagId(null)
      }
    })
  }

  function entryOptionLabel(entry: ReviewNoticeEntry): string {
    const department = entry.departmentId === null ? null : departmentNameById.get(entry.departmentId)
    return [entry.ubblNumber, department, entry.amount === null ? null : formatINR(entry.amount)]
      .filter(Boolean)
      .join(' · ')
  }

  const heading = reviewTagNoticeHeading(
    departments.map((d) => d.name),
    rows.length
  )

  return (
    <section
      aria-label="Tags for this bill's departments"
      className="rounded-md border border-sky-200 bg-sky-50/60 px-2 py-1.5 dark:border-sky-900 dark:bg-sky-950/30"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag className="h-3.5 w-3.5 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden />
        <span className="text-xs font-medium">{heading}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {open ? 'Check before treating this bill as a new purchase.' : rows.map((r) => r.name).join(', ')}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>

      {open ? (
        <div className="mt-1 max-h-40 overflow-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr className="border-b border-sky-200/70 dark:border-sky-900/70">
                <th scope="col" className="py-1 pr-3 font-medium">Tag</th>
                <th scope="col" className="py-1 pr-3 font-medium">Period</th>
                <th scope="col" className="py-1 pr-3 font-medium">Covers</th>
                <th scope="col" className="py-1 pr-3 font-medium">Note for this event</th>
                <th scope="col" className="py-1 text-right font-medium">
                  <span className="sr-only">Link status</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const linkedIds = linkedIdsFor(row)
                const linkedEntries = entries.filter((e) => linkedIds.has(e.entryId))
                const unlinked = unlinkedEntriesForTag(entries, linkedIds)
                const direct = liveEntries.some((e) => tagRowMatchesEntry(row, e))
                const busy = isPending && pendingTagId === row.tagId
                const picked = choice[row.tagId]
                const selectedId =
                  picked !== undefined && unlinked.some((e) => e.entryId === picked)
                    ? picked
                    : defaultLinkEntryId(row, unlinked)
                const selected = unlinked.find((e) => e.entryId === selectedId) ?? null
                return (
                  <tr key={row.tagId} className="border-b border-sky-100 last:border-0 dark:border-sky-900/40">
                    <td className="py-1 pr-3 align-top">
                      <Link
                        href={`/tags/${row.tagId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary hover:underline"
                        title="Opens the tag in a new tab, so this review stays as it is"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 align-top text-muted-foreground">{row.periodLabel}</td>
                    <td className={`py-1 pr-3 align-top ${direct ? '' : 'text-muted-foreground'}`}>
                      {reviewTagCoverageLabel(row, multiDepartment)}
                    </td>
                    <td className="py-1 pr-3 align-top">
                      {row.note ? row.note : <span className="text-muted-foreground">No note</span>}
                    </td>
                    <td className="py-1 text-right align-top">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {linkedEntries.length > 0 ? (
                          <Badge
                            variant="success"
                            title={multiEntry ? `Linked: ${linkedEntries.map((e) => e.ubblNumber).join(', ')}` : undefined}
                          >
                            {multiEntry ? `Linked: ${linkedEntries.map((e) => e.ubblNumber).join(', ')}` : 'Linked'}
                          </Badge>
                        ) : null}
                        {canLink && selected ? (
                          <>
                            {multiEntry ? (
                              <SelectNative
                                aria-label={`Entry to link to ${row.name}`}
                                className="h-6 w-auto max-w-56 py-0 text-xs"
                                value={selected.entryId}
                                disabled={isPending}
                                onChange={(e) => setChoice((prev) => ({ ...prev, [row.tagId]: Number(e.target.value) }))}
                              >
                                {unlinked.map((e) => (
                                  <option key={e.entryId} value={e.entryId}>
                                    {entryOptionLabel(e)}
                                  </option>
                                ))}
                              </SelectNative>
                            ) : null}
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs"
                              disabled={isPending}
                              onClick={() => handleLink(row.tagId, row.name, selected)}
                              title={`Link ${multiEntry ? selected.ubblNumber : 'this entry'} to "${row.name}"`}
                            >
                              {busy ? 'Linking…' : 'Link'}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}
