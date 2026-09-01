'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { resetStaffPassword } from '@/lib/actions/admin'
import { generateTemporaryPassword } from '@/lib/generate-password'

export function ResetPasswordDialog({ staffId, displayName }: { staffId: string; displayName: string }) {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  function handleSubmit() {
    startTransition(async () => {
      const result = await resetStaffPassword({ id: staffId, password })
      if (result.ok) {
        toast.success(`Password reset for ${displayName}. Share the new password with them directly.`)
        setPassword('')
        setOpen(false)
      } else {
        toastError(result.error, { context: 'reset-password-dialog' })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setPassword('')
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reset password
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password for {displayName}</DialogTitle>
          <DialogDescription>
            This immediately replaces their current password. Share the new one with them out of band.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-password">New password</Label>
          <div className="flex gap-2">
            <Input
              id="reset-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 10 characters"
            />
            <Button type="button" variant="outline" onClick={() => setPassword(generateTemporaryPassword())}>
              Generate
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={handleSubmit} disabled={isPending || password.length < 10}>
            {isPending ? 'Resetting…' : 'Reset password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
