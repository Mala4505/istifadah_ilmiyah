'use client'

import { useState, useTransition, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { loginWithIts } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Logo } from '@/components/app-shell/logo'
import { FriendlyError } from '@/components/ui/friendly-error'

// Screen 1 — Sign in (MASTER-PLAN §5). ITS number + password: the server
// action (lib/actions/auth.ts) resolves the ITS number to Supabase Auth's
// internal login identifier and rate-limits attempts — the browser never
// sees anything but the ITS number the user typed.
export default function LoginPage() {
  const router = useRouter()
  const [itsNumber, setItsNumber] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    startTransition(async () => {
      const result = await loginWithIts(itsNumber, password)
      if (!result.ok) {
        setError(result.error)
        return
      }
      router.replace('/')
      router.refresh()
    })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Logo className="mb-2" imageClassName="w-40" />
          <CardTitle className="text-xl tracking-tight">Istifadah Ilmiyah 1448H</CardTitle>
          <CardDescription>Sign in with your ITS number to continue.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <div className="flex flex-col gap-2">
              <Label htmlFor="its-number">ITS Number</Label>
              <Input
                id="its-number"
                name="its-number"
                type="text"
                inputMode="numeric"
                autoComplete="username"
                maxLength={8}
                placeholder="Enter ITS Number"
                value={itsNumber}
                onChange={(event) => setItsNumber(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder='Enter Password'
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
            {error && (
              <div role="alert">
                <FriendlyError message={error} />
              </div>
            )}
            <Button type="submit" disabled={isPending} className="mt-1">
              {isPending ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="justify-center border-t border-border pt-4 text-muted-foreground">
          <span className="text-[12px] font-medium tracking-wide">© Maktab Umoor Maliyah</span>
        </CardFooter>
      </Card>
    </main>
  )
}
