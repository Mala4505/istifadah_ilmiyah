'use client'

import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SelectNative } from '@/components/ui/select-native'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dedupeScopePicks, type DepartmentRef, type ScopePick, type SubDepartmentRef } from '@/lib/tags/shared'

/**
 * Department + optional sub-department chooser used by the create form (picks are held in
 * state until Save) and, with `onAdd`, by the tag detail page (each add is saved straight
 * away). Both share the add row; only what happens to a pick differs.
 */
export function ScopeAddRow({
  departments,
  subDepartments,
  disabled,
  onAdd,
}: {
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  disabled?: boolean
  onAdd: (pick: ScopePick) => void
}) {
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [subDepartmentId, setSubDepartmentId] = useState<number | null>(null)
  const subOptions = useMemo(
    () => (departmentId === null ? [] : subDepartments.filter((s) => s.departmentId === departmentId)),
    [subDepartments, departmentId]
  )

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-44 flex-1">
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="scope-department">
          Department
        </label>
        <SelectNative
          id="scope-department"
          value={departmentId === null ? '' : String(departmentId)}
          disabled={disabled}
          onChange={(e) => {
            setDepartmentId(e.target.value ? Number(e.target.value) : null)
            setSubDepartmentId(null)
          }}
        >
          <option value="">Pick a department</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <div className="min-w-44 flex-1">
        <label className="mb-1 block text-xs text-muted-foreground" htmlFor="scope-sub-department">
          Sub-department (optional)
        </label>
        <SelectNative
          id="scope-sub-department"
          value={subDepartmentId === null ? '' : String(subDepartmentId)}
          disabled={disabled || subOptions.length === 0}
          onChange={(e) => setSubDepartmentId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">Whole department</option>
          {subOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectNative>
      </div>
      <Button
        type="button"
        variant="outline"
        disabled={disabled || departmentId === null}
        onClick={() => {
          if (departmentId === null) return
          onAdd({ departmentId, subDepartmentId })
          setSubDepartmentId(null)
        }}
      >
        <Plus className="h-4 w-4" />
        Add
      </Button>
    </div>
  )
}

/** The create form's held picks: a table with the add row beneath it. */
export function ScopePicksEditor({
  departments,
  subDepartments,
  picks,
  onChange,
}: {
  departments: DepartmentRef[]
  subDepartments: SubDepartmentRef[]
  picks: ScopePick[]
  onChange: (picks: ScopePick[]) => void
}) {
  const departmentName = (id: number) => departments.find((d) => d.id === id)?.name ?? 'Unknown department'
  const subName = (id: number | null) =>
    id === null ? 'Whole department' : (subDepartments.find((s) => s.id === id)?.name ?? 'Unknown')

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Department</TableHead>
              <TableHead>Sub-department</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {picks.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-4 text-center text-sm text-muted-foreground">
                  No department yet — a tag needs at least one.
                </TableCell>
              </TableRow>
            ) : (
              picks.map((pick) => (
                <TableRow key={`${pick.departmentId}:${pick.subDepartmentId ?? ''}`}>
                  <TableCell>{departmentName(pick.departmentId)}</TableCell>
                  <TableCell>{subName(pick.subDepartmentId)}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={`Remove ${departmentName(pick.departmentId)}`}
                      onClick={() =>
                        onChange(
                          picks.filter(
                            (p) => !(p.departmentId === pick.departmentId && p.subDepartmentId === pick.subDepartmentId)
                          )
                        )
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <ScopeAddRow
        departments={departments}
        subDepartments={subDepartments}
        onAdd={(pick) => onChange(dedupeScopePicks([...picks, pick]))}
      />
    </div>
  )
}
