import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@/lib/supabase/server'
import { publicEnv } from '@/lib/env'
import { BookmarkletWorkspace } from '@/components/import/bookmarklet-workspace'

/**
 * /import/bookmarklet (MASTER-PLAN §17.23, Phase 3 item 1).
 *
 * Mints a scrape token and hands the operator a one-time drag-to-install
 * bookmarklet with that token baked into it.
 *
 * The bookmarklet source is read from disk here rather than imported, so
 * public/bookmarklet/read-portal.js stays a plain, readable, lintable file that
 * a reviewer can audit — the thing being pasted into a finance portal should
 * not be a build artifact nobody can read. `readFile` at request time also
 * means editing that file takes effect without a rebuild.
 *
 * Same double-check pattern as /import: this page's admin gate is a UX nicety;
 * app/api/scrape-token/route.ts is the enforcement point.
 */
export const dynamic = 'force-dynamic'

export default async function BookmarkletPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  let isAdmin = false
  if (user) {
    const { data: profile } = await supabase
      .from('staff_profile')
      .select('role, is_active')
      .eq('id', user.id)
      .maybeSingle()
    isAdmin = Boolean(profile?.is_active && profile.role === 'admin')
  }

  const source = await readFile(
    path.join(process.cwd(), 'public', 'bookmarklet', 'read-portal.js'),
    'utf8'
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Portal reader</h1>
        <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-accent-foreground">
          Phase 3
        </span>
      </div>
      <BookmarkletWorkspace
        isAdmin={isAdmin}
        source={source}
        hubUrl={publicEnv.NEXT_PUBLIC_SITE_URL}
      />
    </div>
  )
}
