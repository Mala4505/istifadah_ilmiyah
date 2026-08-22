import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { NavRail } from '@/components/app-shell/nav-rail'
import { CommandPalette } from '@/components/app-shell/command-palette'

// Authenticated app shell wrapping every screen in MASTER-PLAN §5 except
// /login. Redirects server-side if there is no session — no flash of
// protected content while a client-side check catches up.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('staff_profile')
    .select('display_name, role, its_number')
    .eq('id', user.id)
    .maybeSingle()

  return (
    <div className="flex min-h-screen bg-background">
      <NavRail
        user={{
          displayName: profile?.display_name ?? user.email ?? 'Staff',
          role: profile?.role ?? null,
          itsNumber: profile?.its_number ?? null,
        }}
      />
      <main className="min-w-0 flex-1 p-6">{children}</main>
      <CommandPalette />
    </div>
  )
}
