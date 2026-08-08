// Row shape read from `public.v_entry_enriched` (MASTER-PLAN §10.2). Hand-written
// rather than generated — no `supabase gen types` run yet in this repo — but kept in
// lockstep with supabase/migrations/20260808000028_reporting_views.sql's SELECT list.
export type EntryEnriched = {
  id: number
  type: 'invoice' | 'reimbursement' | 'advance_payment'
  ubbl_number: string
  main_number: string | null
  department_id: number | null
  department_name: string | null
  budget_head_id: number | null
  budget_head_raw_label: string | null
  budget_head_short_label: string | null
  invoice_number: string | null
  vendor_id: number | null
  vendor_display_name: string | null
  vendor_raw: string | null
  date: string | null
  tenant_amount: number | null
  main_amount: number | null
  amount_variance: number | null
  variance_reason: string | null
  tenant_status_id: number | null
  tenant_status_code: string | null
  tenant_status_label: string | null
  main_status_id: number | null
  main_status_code: string | null
  main_status_label: string | null
  tenant_status_raw: string | null
  main_status_raw: string | null
  head_id: number | null
  head_name: string | null
  zone_id: number | null
  zone_name: string | null
  hub_reference: string | null
  enrichment_note: string | null
  hub_status_id: number
  hub_status_code: string
  hub_status_label: string
  hub_status_changed_at: string | null
  hub_status_changed_by: string | null
  hub_status_note: string | null
  hub_status_exported_at: string | null
  settles_entry_id: number | null
  is_void: boolean
  void_reason: string | null
  source: 'import' | 'manual' | 'api'
  import_batch_id: number | null
  created_at: string
  updated_at: string
  document_count: number
}

export type LookupOption = { id: number; label: string; department_id?: number | null; code?: string }

export type FilterOptions = {
  departments: LookupOption[]
  budgetHeads: LookupOption[]
  heads: LookupOption[]
  zones: LookupOption[]
  tenantStatuses: LookupOption[]
  mainStatuses: LookupOption[]
  hubStatuses: LookupOption[]
}

// Every filter the entries list supports (MASTER-PLAN §5 row 3), mirrored 1:1 into URL
// search params so a filtered view is shareable/bookmarkable.
export type EntriesFilters = {
  department: string
  budgetHead: string
  head: string
  zone: string
  tenantStatus: string
  mainStatus: string
  hubStatus: string
  exportPending: boolean
  dateFrom: string
  dateTo: string
  vendor: string
  hasVariance: boolean
  hasDocument: boolean
}

export const DEFAULT_FILTERS: EntriesFilters = {
  department: '',
  budgetHead: '',
  head: '',
  zone: '',
  tenantStatus: '',
  mainStatus: '',
  hubStatus: '',
  exportPending: false,
  dateFrom: '',
  dateTo: '',
  vendor: '',
  hasVariance: false,
  hasDocument: false,
}

export const PAGE_SIZE = 50

export type ColumnKey =
  | 'ubbl_number'
  | 'main_number'
  | 'department_name'
  | 'budget_head_short_label'
  | 'head_name'
  | 'zone_name'
  | 'vendor_display_name'
  | 'invoice_number'
  | 'date'
  | 'tenant_amount'
  | 'main_amount'
  | 'amount_variance'
  | 'tenant_status_label'
  | 'main_status_label'
  | 'hub_status_label'
  | 'export_pending'
  | 'document_count'

export type ColumnDef = {
  key: ColumnKey
  label: string
  defaultVisible: boolean
  align?: 'left' | 'right'
}

export const ALL_COLUMNS: ColumnDef[] = [
  { key: 'ubbl_number', label: 'UBBL #', defaultVisible: true },
  { key: 'main_number', label: 'Main #', defaultVisible: true },
  { key: 'date', label: 'Date', defaultVisible: true },
  { key: 'vendor_display_name', label: 'Vendor', defaultVisible: true },
  { key: 'department_name', label: 'Department', defaultVisible: false },
  { key: 'budget_head_short_label', label: 'Budget head', defaultVisible: true },
  { key: 'head_name', label: 'Head', defaultVisible: false },
  { key: 'zone_name', label: 'Zone', defaultVisible: false },
  { key: 'invoice_number', label: 'Invoice #', defaultVisible: false },
  { key: 'tenant_amount', label: 'Tenant amt', defaultVisible: true, align: 'right' },
  { key: 'main_amount', label: 'Main amt', defaultVisible: true, align: 'right' },
  { key: 'amount_variance', label: 'Variance', defaultVisible: true, align: 'right' },
  { key: 'tenant_status_label', label: 'Tenant status', defaultVisible: true },
  { key: 'main_status_label', label: 'Main status', defaultVisible: false },
  { key: 'hub_status_label', label: 'Hub status', defaultVisible: true },
  { key: 'export_pending', label: 'Export', defaultVisible: false },
  { key: 'document_count', label: 'Docs', defaultVisible: true, align: 'right' },
]
