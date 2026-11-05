import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatMoney } from '@/components/entries/format'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isSuperadmin } from '@/lib/auth/roles'
import { getSelectedEventId } from '@/lib/events/current'
import { loadTagDetail, loadTagReferenceData } from '@/lib/tags/queries'
import { formatINR } from '@/lib/reports/format'
import {
  eventLabel,
  eventsInTagPeriod,
  groupEntriesByEvent,
  groupScopeByDepartment,
  sortEventsAscending,
  summarizeEntries,
  tagPeriodLabel,
} from '@/lib/tags/shared'
import { EditTagDialog } from '@/components/tags/tag-form-dialog'
import {
  AddScopeControl,
  DeleteTagButton,
  EventNoteEditor,
  LinkEntriesDialog,
  RemoveScopeButton,
  UnlinkEntryButton,
} from '@/components/tags/tag-detail-controls'

export const dynamic = 'force-dynamic'

function Message({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 pt-6">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{body}</p>
      </CardContent>
    </Card>
  )
}

export default async function TagDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaffContext()
  if (!staff) return <Message title="Sign in required" body="You need to sign in to view tags." />
  if (!staff.isActive) {
    return <Message title="Your account is pending activation" body="An admin needs to activate your account first." />
  }

  const { id: rawId } = await params
  const tagId = Number(rawId)
  if (!Number.isInteger(tagId) || tagId <= 0) notFound()

  const canEdit = isSuperadmin(staff.role)
  const supabase = await createClient()
  const [detail, reference, selectedEventId] = await Promise.all([
    loadTagDetail(supabase, tagId),
    loadTagReferenceData(supabase),
    getSelectedEventId(),
  ])

  if (detail.error && !detail.tag) {
    return (
      <div className="flex flex-col gap-4">
        <BackLink />
        <FriendlyError message={detail.error} />
      </div>
    )
  }
  // No row also covers "not a tag your departments touch": RLS hides it.
  if (!detail.tag) notFound()
  const tag = detail.tag

  const { events, allDepartments, allSubDepartments } = reference
  const eventById = new Map(events.map((e) => [e.id, e]))
  const startEvent = eventById.get(tag.start_event_id)
  const endEvent = tag.end_event_id === null ? null : (eventById.get(tag.end_event_id) ?? null)

  const departmentName = (id: number) => allDepartments.find((d) => d.id === id)?.name ?? 'Unknown department'
  const subName = (id: number) => allSubDepartments.find((s) => s.id === id)?.name ?? 'Unknown'

  // ---- Per-event table: every event in the tag's period, plus any event holding spend or a note.
  const costByEvent = new Map(detail.costs.map((c) => [c.event_id, c]))
  const noteByEvent = new Map(detail.notes.map((n) => [n.event_id, n.note]))
  const periodEvents = eventsInTagPeriod(events, tag.start_event_id, tag.end_event_id)
  const extraIds = new Set([...costByEvent.keys(), ...noteByEvent.keys()])
  for (const e of periodEvents) extraIds.delete(e.id)
  const eventRows = sortEventsAscending([
    ...periodEvents,
    ...[...extraIds].flatMap((eventId) => {
      const e = eventById.get(eventId)
      return e ? [e] : []
    }),
  ])
  const totalCost = detail.costs.reduce((sum, c) => sum + c.cost, 0)

  // ---- Linked entries grouped by event.
  const entryGroups = groupEntriesByEvent(detail.entries, events)

  const scopeGroups = groupScopeByDepartment(detail.scope, departmentName, subName)
  const scopeSortKey = (row: { department_id: number; sub_department_id: number | null }) =>
    `${departmentName(row.department_id)}\u0000${row.sub_department_id === null ? '' : subName(row.sub_department_id)}`
  const scopeRows = [...detail.scope].sort((a, b) => scopeSortKey(a).localeCompare(scopeSortKey(b)))

  return (
    <div className="flex flex-col gap-4">
      <BackLink />

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">{tag.name}</h1>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="secondary" className="tabular-nums">
              {tagPeriodLabel(startEvent, endEvent)}
            </Badge>
            <span>
              {scopeGroups.map((g) => g.departmentName).join(', ') || 'No department'}
            </span>
          </div>
          {tag.description && <p className="max-w-3xl whitespace-pre-line text-sm">{tag.description}</p>}
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <EditTagDialog
              tag={{
                id: tag.id,
                name: tag.name,
                description: tag.description,
                startEventId: tag.start_event_id,
                endEventId: tag.end_event_id,
              }}
              events={events}
            />
            <LinkEntriesDialog
              tagId={tag.id}
              events={events}
              departments={reference.departments}
              subDepartments={reference.subDepartments}
              defaultEventId={selectedEventId}
            />
            <DeleteTagButton tagId={tag.id} tagName={tag.name} />
          </div>
        )}
      </div>

      {detail.error && <FriendlyError message={detail.error} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost and yearly note</CardTitle>
          <CardDescription>
            What the linked entries cost in each event (voided entries are not counted), and one optional note per
            event, such as &quot;12 tents torn&quot;.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">Entries</TableHead>
                <TableHead className="text-right">Voided</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {eventRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    This tag&apos;s start event could not be found.
                  </TableCell>
                </TableRow>
              ) : (
                eventRows.map((event) => {
                  const cost = costByEvent.get(event.id)
                  const note = noteByEvent.get(event.id) ?? ''
                  const role = event.id === tag.start_event_id ? 'Built' : 'Maintained'
                  return (
                    <TableRow key={event.id} className="align-top">
                      <TableCell className="py-3">{eventLabel(event)}</TableCell>
                      <TableCell className="py-3 text-muted-foreground">
                        {cost && cost.entry_count > 0 ? role : '—'}
                      </TableCell>
                      <TableCell className="py-3 text-right tabular-nums">{cost?.entry_count ?? 0}</TableCell>
                      <TableCell className="py-3 text-right tabular-nums">{cost?.voided_count ?? 0}</TableCell>
                      <TableCell className="py-3 text-right tabular-nums">
                        {cost && cost.entry_count > 0 ? formatINR(cost.cost) : '—'}
                      </TableCell>
                      <TableCell className="max-w-96 whitespace-normal py-3">
                        {canEdit ? (
                          <EventNoteEditor
                            // Remount when the saved value changes so the box shows what was stored.
                            key={`${event.id}:${note}`}
                            tagId={tag.id}
                            eventId={event.id}
                            initialNote={note}
                            hijriYear={event.hijriYear}
                          />
                        ) : (
                          note || <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })
              )}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell colSpan={4} className="text-right">
                  Total, all events
                </TableCell>
                <TableCell className="text-right tabular-nums">{formatINR(totalCost)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Departments</CardTitle>
          <CardDescription>
            Any row can be removed with the cross. A row that came from a linked entry may appear again if that entry
            is linked again or its sub-department is set again. A tag always keeps at least one department.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Sub-department</TableHead>
                <TableHead>Added</TableHead>
                {canEdit && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {scopeRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canEdit ? 4 : 3} className="py-6 text-center text-muted-foreground">
                    No departments on this tag.
                  </TableCell>
                </TableRow>
              ) : (
                scopeRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{departmentName(row.department_id)}</TableCell>
                    <TableCell>
                      {row.sub_department_id === null ? (
                        <span className="text-muted-foreground">Whole department</span>
                      ) : (
                        subName(row.sub_department_id)
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.source === 'manual' ? 'By hand' : 'From a linked entry'}
                    </TableCell>
                    {canEdit && (
                      <TableCell>
                        <RemoveScopeButton
                          tagId={tag.id}
                          scopeId={row.id}
                          fromEntry={row.source === 'entry'}
                          label={
                            row.sub_department_id === null
                              ? departmentName(row.department_id)
                              : `${departmentName(row.department_id)} › ${subName(row.sub_department_id)}`
                          }
                        />
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {canEdit && (
            <div className="px-4 pb-4">
              <AddScopeControl
                tagId={tag.id}
                departments={reference.departments}
                subDepartments={reference.subDepartments}
              />
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Linked entries</CardTitle>
          <CardDescription>
            Grouped by event. Voided entries stay linked and are marked, but never counted in a total.
            {canEdit && ' Unlinking an entry keeps the departments it added to the tag.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 p-0 pb-4">
          {detail.hiddenEntryCount > 0 && (
            <p className="px-6 text-sm text-muted-foreground">
              {detail.hiddenEntryCount} more linked {detail.hiddenEntryCount === 1 ? 'entry belongs' : 'entries belong'}{' '}
              to departments you cannot see, so {detail.hiddenEntryCount === 1 ? 'it is' : 'they are'} not listed or
              counted here.
            </p>
          )}
          {entryGroups.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">
              {detail.hiddenEntryCount > 0
                ? 'No linked entries you can see.'
                : 'No entries are linked. A tag can exist on departments and a description alone.'}
            </p>
          ) : (
            entryGroups.map((group) => {
              const totals = summarizeEntries(group.entries)
              return (
                <section key={group.event.id} className="flex flex-col gap-2">
                  <h3 className="px-6 text-sm font-medium">
                    {eventLabel(group.event)}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {totals.activeCount} {totals.activeCount === 1 ? 'entry' : 'entries'}
                      {totals.voidedCount > 0 ? `, ${totals.voidedCount} voided` : ''}
                    </span>
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>UBBL no.</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Vendor</TableHead>
                        <TableHead>Department</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        {canEdit && <TableHead className="w-24" />}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.entries.map((entry) => (
                        <TableRow key={entry.id} className={entry.is_void ? 'bg-muted/40 text-muted-foreground' : undefined}>
                          <TableCell className="font-mono text-xs">
                            <Link href={`/entries/${entry.id}`} className="text-primary hover:underline">
                              {entry.ubbl_number}
                            </Link>
                          </TableCell>
                          <TableCell>{formatDate(entry.date)}</TableCell>
                          <TableCell className="max-w-56 truncate">
                            {entry.vendor_display_name ?? entry.vendor_raw ?? '—'}
                          </TableCell>
                          <TableCell>
                            {entry.department_name ?? '—'}
                            {entry.sub_department_name ? ` › ${entry.sub_department_name}` : ''}
                          </TableCell>
                          <TableCell>
                            {entry.is_void ? (
                              <Badge variant="destructive" title={entry.void_note ?? undefined}>
                                Voided
                              </Badge>
                            ) : (
                              (entry.status_label ?? '—')
                            )}
                          </TableCell>
                          <TableCell
                            className={`text-right tabular-nums ${entry.is_void ? 'line-through' : ''}`}
                            title={entry.is_void ? 'Voided — not counted in the total' : undefined}
                          >
                            {formatMoney(entry.amount)}
                          </TableCell>
                          {canEdit && (
                            <TableCell>
                              <UnlinkEntryButton tagId={tag.id} entryId={entry.id} ubbl={entry.ubbl_number} />
                            </TableCell>
                          )}
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell colSpan={5} className="text-right">
                          Total, voided excluded
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatMoney(totals.total)}</TableCell>
                        {canEdit && <TableCell />}
                      </TableRow>
                    </TableFooter>
                  </Table>
                </section>
              )
            })
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/tags"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      Tags
    </Link>
  )
}
