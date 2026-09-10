/**
 * Shared row shapes and supabase-js embed normalisers for the per-area
 * Settings loaders (lib/settings/load*.ts). Lifted verbatim from the
 * former single `loadSuperadminData` in app/(app)/settings/page.tsx as
 * part of the Phase 2 Settings redesign (Direction A) -- behaviour is
 * unchanged, the queries are just split per area so each sub-route pays
 * only for its own.
 */

export type DepartmentOption = { id: number; name: string }

export type ZoneRow = {
  id: number
  departmentId: number
  zoneNumber: number
  name: string
}

export type SubDepartmentRow = {
  id: number
  departmentId: number
  name: string
  isActive: boolean
  budgetAmount: number | null
}

export type HubStatusRow = {
  id: number
  code: string
  label: string
  sortOrder: number
  isExportable: boolean
  isTerminal: boolean
}

/** A department name embedded via a to-one FK select can come back as an
 * object or a one-element array depending on supabase-js's relationship
 * inference -- normalise both shapes here. */
export function extractDepartmentName(value: unknown): string | null {
  if (Array.isArray(value)) {
    const first = value[0] as { name?: string } | undefined
    return first?.name ?? null
  }
  return (value as { name?: string } | null)?.name ?? null
}

/** A to-many junction embed (staff_department(department_id)) comes back from
 * supabase-js as an array of rows shaped like the selected columns -- here
 * `{ department_id: number }[]` -- one entry per membership row. Defensive
 * against a null/undefined embed the same way extractDepartmentName is. */
export function extractDepartmentIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => (entry as { department_id?: number | null } | null)?.department_id)
    .filter((id): id is number => typeof id === 'number')
}
