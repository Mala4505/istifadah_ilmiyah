import { Card, CardContent } from '@/components/ui/card'
import { FriendlyError } from '@/components/ui/friendly-error'
import { createClient } from '@/lib/supabase/server'
import { getStaffContext } from '@/lib/export/auth'
import { isSuperadmin } from '@/lib/auth/roles'
import { getSelectedEvent } from '@/lib/events/current'
import { loadTagReferenceData, loadTagsActiveInEvent, type TagListData } from '@/lib/tags/queries'
import { eventLabel, filterTagIdsByScope } from '@/lib/tags/shared'
import { TagFilters } from '@/components/tags/tag-filters'
import { TagListTable } from '@/components/tags/tag-list-table'
import { CreateTagDialog } from '@/components/tags/tag-form-dialog'

/**
 * /tags -- named records of things an event's spending left behind (a washroom block, tent
 * stock, equipment), shown in every event from their start event to their end event
 * (docs/entry-tags-plan.md, Phase 2). Any active staff member can open the page; what they
 * see is whatever RLS lets them (a department user: only tags touching their departments).
 * Create / edit controls are super-admin only -- UI courtesy; the tables' RLS is the gate.
 */
export const dynamic = 'force-dynamic'

const EMPTY_LIST: TagListData = { tags: [], scope: [], costs: [], notesByTag: new Map(), error: null }

function parseId(raw: string | undefined): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

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

export default async function TagsPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string; sub?: string }>
}) {
  const staff = await getStaffContext()
  if (!staff) return <Message title="Sign in required" body="You need to sign in to view tags." />
  if (!staff.isActive) {
    return <Message title="Your account is pending activation" body="An admin needs to activate your account first." />
  }

  const sp = await searchParams
  const departmentId = parseId(sp.department)
  const subDepartmentId = parseId(sp.sub)
  const canEdit = isSuperadmin(staff.role)

  const supabase = await createClient()
  const [reference, selectedEvent] = await Promise.all([loadTagReferenceData(supabase), getSelectedEvent()])
  const list = selectedEvent ? await loadTagsActiveInEvent(supabase, selectedEvent.id) : EMPTY_LIST

  const allowedIds = filterTagIdsByScope(list.scope, { departmentId, subDepartmentId })
  const tags = allowedIds ? list.tags.filter((t) => allowedIds.has(t.id)) : list.tags
  const filtered = allowedIds !== null

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight">Tags</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Things earlier spending left behind — a washroom block, tent stock, equipment — so a similar bill or
            request can be recognised as maintenance.
            {selectedEvent && (
              <>
                {' '}
                Showing the tags active in <span className="font-medium text-foreground">{eventLabel(selectedEvent)}</span>.
              </>
            )}
          </p>
        </div>
        {canEdit && (
          <CreateTagDialog
            events={reference.events}
            departments={reference.departments}
            subDepartments={reference.subDepartments}
            defaultEventId={selectedEvent?.id ?? null}
          />
        )}
      </div>

      <TagFilters
        departments={reference.departments}
        subDepartments={reference.subDepartments}
        departmentId={departmentId}
        subDepartmentId={subDepartmentId}
      />

      {reference.error && <FriendlyError message={reference.error} />}
      {list.error && <FriendlyError message={list.error} />}

      <Card>
        <CardContent className="p-0">
          {!selectedEvent ? (
            <p className="p-6 text-sm text-muted-foreground">No event is selected, so there are no tags to show.</p>
          ) : tags.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              {filtered
                ? 'No tag in this event matches that department. Clear the filters to see them all.'
                : canEdit
                  ? `No tags are active in ${selectedEvent.hijriYear} H yet. Use “New tag” to record one.`
                  : `No tags are active in ${selectedEvent.hijriYear} H.`}
            </p>
          ) : (
            <TagListTable
              tags={tags}
              scope={list.scope}
              costs={list.costs}
              notesByTag={list.notesByTag}
              events={reference.events}
              departments={reference.allDepartments}
              subDepartments={reference.allSubDepartments}
              selectedEvent={selectedEvent}
            />
          )}
        </CardContent>
      </Card>
    </div>
  )
}
