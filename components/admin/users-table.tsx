'use client'

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { updateStaffProfile } from '@/lib/actions/admin'

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

/** Order-independent comparison — the checkbox list can toggle ids in any order. */
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
          <TableHead>Department</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Active</TableHead>
          <TableHead className="text-right">Save</TableHead>
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

  const isDirty =
    role !== row.role || !sameDepartmentIds(departmentIds, row.departmentIds) || isActive !== row.isActive

  function toggleDepartment(departmentId: number, checked: boolean) {
    setDepartmentIds((current) =>
      checked ? [...current, departmentId] : current.filter((id) => id !== departmentId)
    )
  }

  function handleSave() {
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
        <TableCell>{departmentNames(row.departmentIds, departments)}</TableCell>
        <TableCell>{ROLE_LABELS[row.role]}</TableCell>
        <TableCell>{row.isActive ? 'Yes' : 'No'}</TableCell>
        <TableCell className="text-right" />
      </TableRow>
    )
  }

  return (
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
        {role === 'dept' ? (
          <div className="flex w-[220px] flex-col gap-1 rounded-md border p-2">
            {departments.map((department) => (
              <label key={department.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={departmentIds.includes(department.id)}
                  onCheckedChange={(value) => toggleDepartment(department.id, value === true)}
                />
                {department.name}
              </label>
            ))}
          </div>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </TableCell>
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
        <Checkbox checked={isActive} onCheckedChange={(value) => setIsActive(value === true)} />
      </TableCell>
      <TableCell className="text-right">
        <Button size="sm" disabled={!isDirty || isPending} onClick={handleSave}>
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </TableCell>
    </TableRow>
  )
}
