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
  role: 'admin' | 'reviewer' | 'viewer'
  departmentId: number | null
  isActive: boolean
}

const NO_DEPARTMENT_VALUE = 'none'

function departmentIdToValue(departmentId: number | null): string {
  return departmentId === null ? NO_DEPARTMENT_VALUE : String(departmentId)
}

function valueToDepartmentId(value: string): number | null {
  return value === NO_DEPARTMENT_VALUE ? null : Number(value)
}

export function UsersTable({
  staff,
  departments,
  currentUserId,
}: {
  staff: StaffRow[]
  departments: { id: number; name: string }[]
  currentUserId: string
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
          <UserRow key={row.id} row={row} departments={departments} isCurrentUser={row.id === currentUserId} />
        ))}
      </TableBody>
    </Table>
  )
}

function UserRow({
  row,
  departments,
  isCurrentUser,
}: {
  row: StaffRow
  departments: { id: number; name: string }[]
  isCurrentUser: boolean
}) {
  const [role, setRole] = useState(row.role)
  const [departmentId, setDepartmentId] = useState(row.departmentId)
  const [isActive, setIsActive] = useState(row.isActive)
  const [isPending, startTransition] = useTransition()

  const isDirty = role !== row.role || departmentId !== row.departmentId || isActive !== row.isActive

  function handleSave() {
    startTransition(async () => {
      const result = await updateStaffProfile({
        id: row.id,
        role,
        departmentId,
        isActive,
      })
      if (result.ok) {
        toast.success('Staff profile updated.')
      } else {
        toastError(result.error, { context: 'users-table' })
      }
    })
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
        <Select value={departmentIdToValue(departmentId)} onValueChange={(value) => setDepartmentId(valueToDepartmentId(value))}>
          <SelectTrigger className="w-[180px]">
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
      </TableCell>
      <TableCell>
        <Select value={role} onValueChange={(value) => setRole(value as StaffRow['role'])}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="reviewer">Reviewer</SelectItem>
            <SelectItem value="viewer">Viewer</SelectItem>
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
