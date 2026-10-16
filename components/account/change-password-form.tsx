'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { changeOwnPassword } from '@/lib/actions/account'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/lib/auth/password-policy'

/**
 * Self-service "Change password" (security plan 6.2, D9). The server action is
 * the real gate; the checks here only save a round trip and explain
 * themselves in plain words.
 */
export function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD_LENGTH
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword
  const canSubmit =
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    confirmPassword === newPassword &&
    !isPending

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    startTransition(async () => {
      const result = await changeOwnPassword({ currentPassword, newPassword, confirmPassword })
      if (!result.ok) {
        // Messages from this action are already plain English; toastError also
        // logs the raw string under `context` and runs it through the friendly mapper.
        toastError(result.error, { context: 'change-password-form' })
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      toast.success('Your password has been changed.')
    })
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-sm flex-col gap-4" autoComplete="off">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          disabled={isPending}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          maxLength={MAX_PASSWORD_LENGTH}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          disabled={isPending}
          aria-invalid={tooShort}
        />
        <p className={tooShort ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm-password">Type the new password again</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          maxLength={MAX_PASSWORD_LENGTH}
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={isPending}
          aria-invalid={mismatch}
        />
        {mismatch ? <p className="text-xs text-destructive">The two new passwords do not match.</p> : null}
      </div>
      <div>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isPending ? 'Changing…' : 'Change password'}
        </Button>
      </div>
    </form>
  )
}
