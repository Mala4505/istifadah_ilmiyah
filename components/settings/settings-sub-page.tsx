import type { ReactNode } from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

type GateReason = 'signed_out' | 'inactive' | 'not_admin' | 'not_superadmin'

/** `← Settings` back link shown at the top of every focused sub-route. */
export function SettingsBackLink() {
  return (
    <Link
      href="/settings"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      Settings
    </Link>
  )
}

/** Standard sub-route header: back link + page title. */
export function SettingsSubPageHeader({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-2">
      <SettingsBackLink />
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
    </div>
  )
}

const GATE_COPY: Record<GateReason, { title: string; body: string }> = {
  signed_out: { title: 'Sign in required', body: 'You need to sign in to change settings.' },
  inactive: {
    title: 'Your account is pending activation',
    body: 'An admin needs to activate your account before you can change settings.',
  },
  not_admin: {
    title: 'Admins only',
    body: 'Settings and admin tools are restricted to active admins -- your account does not currently have that role.',
  },
  not_superadmin: {
    title: 'Superadmins only',
    body: 'This settings area is restricted to superadmins.',
  },
}

/** Rendered in place of a sub-route's body when its gate fails. */
export function SettingsGatedState({ reason, title }: { reason: GateReason; title: string }) {
  const copy = GATE_COPY[reason]
  return (
    <div className="flex flex-col gap-4">
      <SettingsSubPageHeader title={title} />
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{copy.title}</p>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
        </CardContent>
      </Card>
    </div>
  )
}

/** The standard sub-route layout: header + gap-stacked children. */
export function SettingsSubPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <SettingsSubPageHeader title={title} />
      {children}
    </div>
  )
}
