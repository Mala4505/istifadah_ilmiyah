import { getStaffContext } from '@/lib/export/auth'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChangePasswordForm } from '@/components/account/change-password-form'

/**
 * /account -- the signed-in person's own account page (change password).
 * Like /shortcuts, it carries no role requirement beyond being signed in and
 * active, so department users can reach it too (the admin-only /settings
 * would have locked them out). The changeOwnPassword action re-checks
 * everything server-side regardless of this page's gate.
 */
export const dynamic = 'force-dynamic'

function PageHeader() {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h1 className="text-xl font-semibold tracking-tight">My account</h1>
    </div>
  )
}

function GatedState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Card>
        <CardContent className="flex flex-col gap-2 pt-6">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  )
}

export default async function AccountPage() {
  const staff = await getStaffContext()
  if (!staff) {
    return <GatedState title="Sign in required" body="You need to sign in to manage your account." />
  }
  if (!staff.isActive) {
    return (
      <GatedState
        title="Your account is pending activation"
        body="An admin needs to activate your account before you can change your password."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />
      <Card>
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            Enter your current password, then choose a new one. You stay signed in on this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  )
}
