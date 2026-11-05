'use client'

import { useMemo, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SelectNative } from '@/components/ui/select-native'
import type { DepartmentRef, SubDepartmentRef } from '@/lib/tags/shared'

/**
 * Department / sub-department filter for the tag list. The state lives in the URL
 * (`?department=&sub=`) so a filtered list is shareable; the page reads it server-side.
 */
export function TagFilters({
  departments,
  subDepartments,
  departmentId,
  subDepartmentId,
}: {
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  departmentId: number | null
  subDepartmentId: number | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [pending, startTransition] = useTransition()

  const subOptions = useMemo(
    () => (departmentId === null ? [] : subDepartments.filter((s) => s.departmentId === departmentId)),
    [subDepartments, departmentId]
  )

  function go(nextDepartment: number | null, nextSub: number | null) {
    const params = new URLSearchParams()
    if (nextDepartment !== null) params.set('department', String(nextDepartment))
    if (nextSub !== null) params.set('sub', String(nextSub))
    const query = params.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname))
  }

  return (
    <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor="tag-filter-department">Department</Label>
        <SelectNative
          id="tag-filter-department"
          value={departmentId === null ? '' : String(departmentId)}
          onChange={(e) => go(e.target.value ? Number(e.target.value) : null, null)}
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="flex min-w-48 flex-col gap-1.5">
        <Label htmlFor="tag-filter-sub-department">Sub-department</Label>
        <SelectNative
          id="tag-filter-sub-department"
          value={subDepartmentId === null ? '' : String(subDepartmentId)}
          disabled={subOptions.length === 0}
          onChange={(e) => go(departmentId, e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">{departmentId === null ? 'Pick a department first' : 'All sub-departments'}</option>
          {subOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectNative>
      </div>
      {(departmentId !== null || subDepartmentId !== null) && (
        <Button variant="ghost" size="sm" onClick={() => go(null, null)}>
          Clear filters
        </Button>
      )}
    </div>
  )
}
