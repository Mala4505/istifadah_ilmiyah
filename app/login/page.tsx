'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// Screen 1 — Sign in (MASTER-PLAN §5). Email + password today; magic-link is
// a nice-to-have noted in the spec, not required for Phase 1A day 1.
export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setPending(true)

    const supabase = createClient()

    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (signInError) {
      setError(signInError.message)
      setPending(false)
      return
    }

    const userId = signInData.user?.id

    if (userId) {
      // `staff_profile` lands with the SQL migrations (MASTER-PLAN §3.8,
      // §10) — this query is written defensively because the table does
      // not exist yet today. A missing table degrades to "let the user
      // through"; an explicit `is_active === false` blocks with the exact
      // copy §5 specifies, not a generic auth error.
      try {
        const { data: profile, error: profileError } = await supabase
          .from('staff_profile')
          .select('is_active')
          .eq('id', userId)
          .maybeSingle()

        if (profileError) {
          console.warn(
            '[login] staff_profile check failed — expected until migrations land:',
            profileError.message
          )
        } else if (profile && profile.is_active === false) {
          await supabase.auth.signOut()
          setError('Your account is pending activation. Ask an administrator to activate it.')
          setPending(false)
          return
        }
      } catch (unexpected) {
        console.warn('[login] staff_profile check threw — treating as not-yet-provisioned:', unexpected)
      }
    }

    router.replace('/')
    router.refresh()
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl tracking-tight">Istifada Ilmiyah Financial Hub</CardTitle>
          <CardDescription>Sign in with your staff account to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={pending} className="mt-1">
              {pending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
