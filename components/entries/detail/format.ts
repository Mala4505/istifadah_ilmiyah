// Display formatting shared across the entry detail screen. Pure functions,
// no hooks, safe to import from either server or client components.

const currencyFormatter = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
})

export function formatMoney(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return currencyFormatter.format(value)
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(d)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

/** yyyy-MM-dd, matching the §5 example verbatim: "exported 2026-08-09". */
export function formatIsoDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toISOString().slice(0, 10)
}

const FIELD_LABELS: Record<string, string> = {
  type: 'Type',
  ubbl_number: 'UBBL number',
  main_number: 'Main number',
  department_id: 'Department',
  budget_head_id: 'Budget head',
  budget_head_raw: 'Budget head (raw)',
  invoice_number: 'Invoice number',
  vendor_id: 'Vendor',
  vendor_raw: 'Vendor (raw)',
  date: 'Date',
  amount: 'Amount',
  variance_reason: 'Variance reason',
  status_id: 'Status',
  status_raw: 'Status (raw)',
  admin_head_id: 'Admin head',
  zone_id: 'Zone',
  cost_center_id: 'Cost center',
  remark: 'Remark',
  hub_status_id: 'Hub status',
  hub_status_note: 'Hub status note',
  hub_status_exported_at: 'Exported at',
  hub_status_export_batch_id: 'Export batch',
  settles_entry_id: 'Settles advance',
  is_void: 'Void',
  source: 'Source',
  import_batch_id: 'Import batch',
  // Pre-2026-08-11 field names, kept so change-log rows written before the
  // entries restructuring (supabase/migrations/20260811000001-3) still render
  // with a readable label instead of falling through to a raw snake_case guess.
  tenant_amount: 'Amount (pre-rename)',
  main_amount: 'Main amount (pre-rename, dropped)',
  amount_variance: 'Variance (pre-rename, dropped)',
  tenant_status_id: 'Status (pre-rename)',
  main_status_id: 'Audit status (pre-rename)',
  tenant_status_raw: 'Status (raw, pre-rename)',
  main_status_raw: 'Audit status (raw, pre-rename)',
  head_id: 'Admin head (pre-rename)',
  hub_reference: 'Hub reference (dropped 2026-08-11)',
  enrichment_note: 'Remark (pre-rename)',
  void_reason: 'Void reason (dropped 2026-08-11)',
  // Pre-2026-08-11 field name: budget_category_id -> cost_center_id (§3.1/§17).
  budget_category_id: 'Cost center (pre-rename)',
}

export function humanizeFieldName(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]
  return field
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

const MONEY_FIELDS = new Set(['amount', 'tenant_amount', 'main_amount', 'amount_variance'])
const DATE_ONLY_FIELDS = new Set(['date'])
const DATETIME_FIELDS = new Set([
  'hub_status_changed_at',
  'hub_status_exported_at',
  'created_at',
  'updated_at',
  'changed_at',
])
const BOOLEAN_FIELDS = new Set(['is_void'])

/**
 * Best-effort human-readable rendering of a raw from/to value out of
 * `entry_change_log.changes` (§3.9). `resolveLookup` lets a caller resolve a
 * foreign-key id (admin_head_id, zone_id, cost_center_id, hub_status_id) to a name/label using
 * option lists already fetched for the page — everything else renders as
 * its raw value, which is honest rather than guessing at a join that isn't
 * available client-side.
 */
export function formatChangeValue(
  field: string,
  value: unknown,
  resolveLookup?: (field: string, id: number) => string | null
): string {
  if (value === null || value === undefined) return '—'

  if (resolveLookup && typeof value === 'number') {
    const resolved = resolveLookup(field, value)
    if (resolved) return resolved
  }

  if (MONEY_FIELDS.has(field) && typeof value === 'number') return formatMoney(value)
  if (DATE_ONLY_FIELDS.has(field) && typeof value === 'string') return formatDate(value)
  if (DATETIME_FIELDS.has(field) && typeof value === 'string') return formatDateTime(value)
  if (BOOLEAN_FIELDS.has(field)) return value ? 'Yes' : 'No'

  if (typeof value === 'string' && value.length > 80) return `${value.slice(0, 77)}…`
  return String(value)
}
