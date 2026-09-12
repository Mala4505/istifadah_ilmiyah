/**
 * Export the Department, Admin Head, Zone and Sub-Department master lists
 * to a single reference workbook (one sheet per list), for sharing with
 * users. Read-only -- does not modify any data.
 *
 * Run from the repo root:
 *   node --env-file=.env scripts/export-masters-xlsx.mjs [out.xlsx]
 *
 * Needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY in .env.
 */
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY.')
  process.exit(1)
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

const [{ data: departments, error: e1 }, { data: adminHeads, error: e2 }, { data: zones, error: e3 }, { data: subDepartments, error: e4 }] =
  await Promise.all([
    supabase.from('department').select('id, name').order('name'),
    supabase.from('admin_head').select('id, department_id, head_number, name').order('department_id').order('head_number'),
    supabase.from('zone').select('id, department_id, zone_number, name').order('department_id').order('zone_number'),
    supabase.from('sub_department').select('id, department_id, name, is_active').order('department_id').order('name'),
  ])

for (const [label, err] of [['department', e1], ['admin_head', e2], ['zone', e3], ['sub_department', e4]]) {
  if (err) throw new Error(`Failed loading ${label}: ${err.message}`)
}

const deptNameById = new Map((departments ?? []).map((d) => [d.id, d.name]))

const wb = XLSX.utils.book_new()

function addSheet(name, header, rows) {
  const aoa = [header, ...rows]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = header.map((h, i) => {
    const maxLen = Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length))
    return { wch: Math.min(Math.max(maxLen + 2, 10), 50) }
  })
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: header.length - 1 } }) }
  XLSX.utils.book_append_sheet(wb, ws, name)
}

addSheet(
  'Departments',
  ['Department'],
  (departments ?? []).map((d) => [d.name]),
)

addSheet(
  'Sub Departments',
  ['Department', 'Sub Department', 'Active'],
  (subDepartments ?? []).map((r) => [
    deptNameById.get(r.department_id) ?? '',
    r.name,
    r.is_active ? 'Yes' : 'No',
  ]),
)

addSheet(
  'Admin Heads',
  ['Department', 'Head No.', 'Admin Head'],
  (adminHeads ?? []).map((r) => [deptNameById.get(r.department_id) ?? '', r.head_number, r.name]),
)

addSheet(
  'Zones',
  ['Department', 'Zone No.', 'Zone'],
  (zones ?? []).map((r) => [deptNameById.get(r.department_id) ?? '', r.zone_number, r.name]),
)

const outPath = process.argv[2] || 'Masters-Reference.xlsx'
XLSX.writeFile(wb, outPath)
console.log(`Wrote ${outPath}`)
console.log(
  `  Departments: ${departments?.length ?? 0}, Sub Departments: ${subDepartments?.length ?? 0}, Admin Heads: ${adminHeads?.length ?? 0}, Zones: ${zones?.length ?? 0}`,
)
