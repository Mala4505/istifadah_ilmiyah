'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DepartmentPicker } from '@/components/admin/department-picker'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { createStaffUser } from '@/lib/actions/admin'
import { generateTemporaryPassword } from '@/lib/generate-password'

export function CreateUserDialog({ departments }: { departments: { id: number; name: string }[] }) {
  const [open, setOpen] = useState(false)
  const [itsNumber, setItsNumber] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [role, setRole] = useState<'superadmin' | 'admin' | 'dept'>('dept')
  const [departmentIds, setDepartmentIds] = useState<number[]>([])
  const [password, setPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  function resetForm() {
    setItsNumber('')
    setDisplayName('')
    setContactEmail('')
    setRole('dept')
    setDepartmentIds([])
    setPassword('')
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await createStaffUser({ itsNumber, displayName, contactEmail, role, departmentIds, password })
      if (result.ok) {
        toast.success(`Account created for ITS ${itsNumber}. Share the password with them directly.`)
        resetForm()
        setOpen(false)
      } else {
        toastError(result.error, { context: 'create-user-dialog' })
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetForm()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">Create user</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create staff account</DialogTitle>
          <DialogDescription>
            Login is the ITS number + this password — the account lands active immediately with the
            role and department set below. Share the password with the new user out of band.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-its-number">ITS Number</Label>
            <Input
              id="new-its-number"
              inputMode="numeric"
              maxLength={8}
              placeholder="12345678"
              value={itsNumber}
              onChange={(event) => setItsNumber(event.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-display-name">Name</Label>
            <Input id="new-display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-contact-email">Contact email (optional)</Label>
            <Input
              id="new-contact-email"
              type="email"
              value={contactEmail}
              onChange={(event) => setContactEmail(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-2">
              <Label>Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="superadmin">Superadmin</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="dept">Dept</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {role === 'dept' && (
              <div className="flex flex-col gap-2">
                <Label>Departments</Label>
                <DepartmentPicker
                  options={departments}
                  selectedIds={departmentIds}
                  onChange={setDepartmentIds}
                  className="w-full"
                />
              </div>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="new-password">Password</Label>
            <div className="flex gap-2">
              <Input
                id="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 10 characters"
              />
              <Button type="button" variant="outline" onClick={() => setPassword(generateTemporaryPassword())}>
                Generate
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={handleSubmit}
            disabled={isPending || itsNumber.length !== 8 || !displayName || password.length < 10}
          >
            {isPending ? 'Creating…' : 'Create account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
