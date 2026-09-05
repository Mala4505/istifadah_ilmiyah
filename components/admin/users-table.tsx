'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { updateStaffProfile } from '@/lib/actions/admin'
import { DepartmentPicker } from '@/components/admin/department-picker'
import { ResetPasswordDialog } from '@/components/admin/reset-password-dialog'

export type StaffRow = {
  id: string
  displayName: string
  itsNumber: string | null
  contactEmail: string | null
  role: 'superadmin' | 'admin' | 'dept'
  departmentIds: number[]
  isActive: boolean
}

const ROLE_LABELS: Record<StaffRow['role'], string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  dept: 'Dept',
}

/** Order-independent comparison — the department picker can toggle ids in any order. */
function sameDepartmentIds(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  return sortedA.every((id, index) => id === sortedB[index])
}

function departmentNames(departmentIds: number[], departments: { id: number; name: string }[]): string {
  if (departmentIds.length === 0) return '—'
  const byId = new Map(departments.map((department) => [department.id, department.name]))
  return departmentIds.map((id) => byId.get(id) ?? `#${id}`).join(', ')
}

export function UsersTable({
  staff,
  departments,
  currentUserId,
  canEdit,
}: {
  staff: StaffRow[]
  departments: { id: number; name: string }[]
  currentUserId: string
  canEdit: boolean
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>ITS Number</TableHead>
          <TableHead>Contact email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Department</TableHead>
          <TableHead>Active</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {staff.map((row) => (
          <UserRow
            key={row.id}
            row={row}
            departments={departments}
            isCurrentUser={row.id === currentUserId}
            canEdit={canEdit}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function UserRow({
  row,
  departments,
  isCurrentUser,
  canEdit,
}: {
  row: StaffRow
  departments: { id: number; name: string }[]
  isCurrentUser: boolean
  canEdit: boolean
}) {
  const [role, setRole] = useState(row.role)
  const [departmentIds, setDepartmentIds] = useState(row.departmentIds)
  const [isActive, setIsActive] = useState(row.isActive)
  const [isPending, startTransition] = useTransition()
  const [selfGuardOpen, setSelfGuardOpen] = useState(false)

  const isDirty =
    role !== row.role || !sameDepartmentIds(departmentIds, row.departmentIds) || isActive !== row.isActive

  // Mirrors the authoritative check in lib/actions/admin.ts's updateStaffProfile:
  // a superadmin editing their own row who is about to lose superadmin or go
  // inactive could lock themselves out with no undo path if they're the last
  // one. The server rejects this outright even if this client guard is
  // bypassed; this dialog just stops it from happening by accident first.
  const isSelfLockout = isCurrentUser && (role !== 'superadmin' || !isActive)

  function performSave() {
    startTransition(async () => {
      const result = await updateStaffProfile({
        id: row.id,
        role,
        departmentIds,
        isActive,
      })
      if (result.ok) {
        toast.success('Staff profile updated.')
      } else {
        toastError(result.error, { context: 'users-table' })
      }
    })
  }

  function handleSave() {
    if (isSelfLockout) {
      setSelfGuardOpen(true)
      return
    }
    performSave()
  }

  function confirmSelfLockout() {
    setSelfGuardOpen(false)
    performSave()
  }

  if (!canEdit) {
    return (
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <span>{row.displayName}</span>
            {isCurrentUser && <Badge variant="outline">You</Badge>}
            {!row.isActive && <Badge variant="warning">Pending activation</Badge>}
          </div>
        </TableCell>
        <TableCell className="font-mono text-sm">{row.itsNumber ?? '—'}</TableCell>
        <TableCell>{row.contactEmail ?? '—'}</TableCell>
        <TableCell>{ROLE_LABELS[row.role]}</TableCell>
        <TableCell className="max-w-[220px] truncate" title={departmentNames(row.departmentIds, departments)}>
          {departmentNames(row.departmentIds, departments)}
        </TableCell>
        <TableCell>{row.isActive ? 'Yes' : 'No'}</TableCell>
        <TableCell className="text-right" />
      </TableRow>
    )
  }

  return (
    <>
      <TableRow>
        <TableCell>
          <div className="flex items-center gap-2">
            <span>{row.displayName}</span>
            {isCurrentUser && <Badge variant="outline">You</Badge>}
            {!isActive && <Badge variant="warning">Pending activation</Badge>}
          </div>
        </TableCell>
        <TableCell className="font-mono text-sm">{row.itsNumber ?? '—'}</TableCell>
        <TableCell>{row.contactEmail ?? '—'}</TableCell>
        <TableCell>
          <Select value={role} onValueChange={(value) => setRole(value as StaffRow['role'])}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="superadmin">Superadmin</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="dept">Dept</SelectItem>
            </SelectContent>
          </Select>
        </TableCell>
        <TableCell>
          {role === 'dept' ? (
            <DepartmentPicker
              options={departments}
              selectedIds={departmentIds}
              onChange={setDepartmentIds}
            />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          <Checkbox checked={isActive} onCheckedChange={(value) => setIsActive(value === true)} />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-2">
            <ResetPasswordDialog staffId={row.id} displayName={row.displayName} />
            <Button size="sm" disabled={!isDirty || isPending} onClick={handleSave}>
              {isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      <Dialog open={selfGuardOpen} onOpenChange={setSelfGuardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {role !== 'superadmin' ? 'Remove your own superadmin access?' : 'Deactivate your own account?'}
            </DialogTitle>
            <DialogDescription>
              {role !== 'superadmin'
                ? 'You are about to change your own role away from Superadmin. If no other superadmin exists, this can lock everyone out of user management.'
                : 'You are about to deactivate your own account. This can sign you out and lock you out of the app immediately.'}{' '}
              Make sure another active superadmin can still manage this account before continuing.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSelfGuardOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={confirmSelfLockout} disabled={isPending}>
              {isPending ? 'Saving…' : 'Yes, continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
