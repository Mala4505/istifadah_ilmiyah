import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import { getCachedUser } from '@/lib/supabase/server'
import { getCachedStaffProfile } from '@/lib/export/auth'
import { NavRail, NAV_RAIL_COLLAPSED_COOKIE } from '@/components/app-shell/nav-rail'
import { CommandPalette } from '@/components/app-shell/command-palette'

// Authenticated app shell wrapping every screen in MASTER-PLAN §5 except
// /login. Redirects server-side if there is no session — no flash of
// protected content while a client-side check catches up.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCachedUser()

  if (!user) {
    redirect('/login')
  }

  const profile = await getCachedStaffProfile(user.id)

  // Task 7.8: read the rail's collapse preference here, server-side, so the
  // client's first render already matches it -- see nav-rail.tsx's cookie
  // doc comment.
  const cookieStore = await cookies()
  const initialCollapsed = cookieStore.get(NAV_RAIL_COLLAPSED_COOKIE)?.value === 'true'

  return (
    <div className="flex min-h-screen bg-background">
      <NavRail
        user={{
          displayName: profile?.display_name ?? user.email ?? 'Staff',
          role: profile?.role ?? null,
          itsNumber: profile?.its_number ?? null,
        }}
        initialCollapsed={initialCollapsed}
      />
      <main className="min-w-0 flex-1 p-3 sm:p-6">{children}</main>
      <CommandPalette />
    </div>
  )
}
