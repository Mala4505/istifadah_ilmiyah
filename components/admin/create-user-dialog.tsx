'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

const NO_DEPARTMENT_VALUE = 'none'

/** Random, readable-enough temporary password — the admin hands it to the new user out of band. */
function generatePassword(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16)
}

export function CreateUserDialog({ departments }: { departments: { id: number; name: string }[] }) {
  const [open, setOpen] = useState(false)
  const [itsNumber, setItsNumber] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'reviewer' | 'viewer'>('viewer')
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [password, setPassword] = useState('')
  const [isPending, startTransition] = useTransition()

  function resetForm() {
    setItsNumber('')
    setDisplayName('')
    setContactEmail('')
    setRole('viewer')
    setDepartmentId(null)
    setPassword('')
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await createStaffUser({ itsNumber, displayName, contactEmail, role, departmentId, password })
      if (result.ok) {
        toast.success(`Account created for ITS ${itsNumber}. Share the password with them directly.`)
        resetForm()
        setOpen(false)
      } else {
        toast.error(result.error)
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
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="reviewer">Reviewer</SelectItem>
                  <SelectItem value="viewer">Viewer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <Label>Department</Label>
              <Select
                value={departmentId === null ? NO_DEPARTMENT_VALUE : String(departmentId)}
                onValueChange={(value) => setDepartmentId(value === NO_DEPARTMENT_VALUE ? null : Number(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEPARTMENT_VALUE}>All departments</SelectItem>
                  {departments.map((department) => (
                    <SelectItem key={department.id} value={String(department.id)}>
                      {department.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
              <Button type="button" variant="outline" onClick={() => setPassword(generatePassword())}>
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
