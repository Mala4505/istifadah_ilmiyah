import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from '@/lib/supabase/server'
import { publicEnv } from '@/lib/env'
import { ImportPageClient } from '@/components/import/import-page-client'
import { isAdminOrAbove } from '@/lib/auth/roles'

/**
 * /import (MASTER-PLAN §5 screen 5, §11.1 day 2; Portal Reader merged in here
 * from its former /import/bookmarklet page). Upload -> dry-run preview with a
 * per-row diff table -> commit; Portal Reader alongside it; committed batch
 * history below both. The admin-role check happens twice by design: here
 * (server-rendered, so a non-admin never even sees the upload form — the
 * permission-denied state itself) and again in app/api/import/route.ts and
 * app/api/scrape-token/route.ts (the actual enforcement points, since this
 * page's check is only a UX nicety — RLS/the routes are what a hand-crafted
 * request cannot bypass).
 */
export const dynamic = 'force-dynamic'

export default async function ImportPage() {
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
    isAdmin = Boolean(profile?.is_active && isAdminOrAbove(profile.role))
  }

  // Read from disk rather than imported, so public/bookmarklet/read-portal.js
  // stays a plain, readable, lintable file a reviewer can audit — the thing
  // being pasted into a finance portal should not be a build artifact nobody
  // can read. `readFile` at request time also means editing that file takes
  // effect without a rebuild.
  const portalReaderSource = await readFile(
    path.join(process.cwd(), 'public', 'bookmarklet', 'read-portal.js'),
    'utf8'
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Import</h1>
      </div>
      <ImportPageClient
        isAdmin={isAdmin}
        portalReaderSource={portalReaderSource}
        hubUrl={publicEnv.NEXT_PUBLIC_SITE_URL}
      />
    </div>
  )
}
