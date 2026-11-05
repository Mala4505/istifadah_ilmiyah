import Link from 'next/link'
import { Tag } from 'lucide-react'
import { noticeHeadline, type TagNoticeGroup } from '@/lib/tags/entries-shared'

/**
 * "Sanitation has 2 tags from earlier years: Washroom block (perpetual), …" -- one line per
 * department, each tag a link to its page. Shown on the Entries list (for the departments in
 * the department filter) and on an entry's detail page (for its own department). Renders
 * nothing when there is nothing to say, so callers never need their own empty check. Plain
 * component with no client hooks, so a Server Component and a Client Component can both use it.
 */
export function EarlierTagsNotice({ groups }: { groups: TagNoticeGroup[] }) {
  if (groups.length === 0) return null
  return (
    <div
      role="note"
      className="flex flex-col gap-1 rounded-lg border border-border bg-accent/40 px-3 py-2 text-sm"
    >
      {groups.map((group) => (
        <p key={group.departmentId} className="flex flex-wrap items-baseline gap-x-1.5">
          <Tag className="h-3.5 w-3.5 shrink-0 self-center text-muted-foreground" aria-hidden />
          <span>{noticeHeadline(group)}:</span>
          {group.tags.map((tag, index) => (
            <span key={tag.id}>
              <Link href={`/tags/${tag.id}`} className="font-medium underline-offset-2 hover:underline">
                {tag.name}
              </Link>{' '}
              <span className="text-muted-foreground">({tag.period})</span>
              {index < group.tags.length - 1 ? ',' : ''}
            </span>
          ))}
        </p>
      ))}
      <p className="text-xs text-muted-foreground">
        These are things earlier events left behind — a similar bill may be maintenance.{' '}
        <Link href="/tags" className="underline-offset-2 hover:underline">
          See all tags
        </Link>
      </p>
    </div>
  )
}
