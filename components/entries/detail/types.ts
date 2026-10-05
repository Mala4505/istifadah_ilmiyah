// Shared shapes for the entry detail screen (MASTER-PLAN §3.4, §5 row 4).
// Hand-written rather than generated — no `supabase gen types` output exists
// in this worktree yet — so these mirror the columns of `v_entry_enriched`
// (20260808000028_reporting_views.sql) and the underlying tables exactly.

export type EntryType = 'invoice' | 'reimbursement' | 'advance_payment'
export type EntrySource = 'import' | 'manual' | 'api'
export type ChangeLogSource = 'import' | 'manual' | 'system'

export interface EntryEnriched {
  id: number
  type: EntryType
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
  amount: number | null
  status_id: number | null
  status_code: string | null
  status_label: string | null
  status_raw: string | null
  admin_head_id: number | null
  admin_head_name: string | null
  zone_id: number | null
  zone_name: string | null
  remark: string | null
  settles_entry_id: number | null
  is_void: boolean
  void_note: string | null
  source: EntrySource
  import_batch_id: number | null
  created_at: string
  updated_at: string
  document_count: number
  /** Vendor (or its merge root) issues no bills — vendor.bill_not_required (20260929000001). */
  bill_exempt: boolean
  // Added by supabase/migrations/20260827000001_entries_type_detail_tables.sql
  // — reimbursement_detail / advance_payment_detail 1:1 extension tables.
  reimbursement_sr_no: string | null
  reimbursement_type: string | null
  reimburse_to_raw: string | null
  advance_invoice_amount: number | null
}

export interface AdminHeadOption {
  id: number
  head_number: number
  name: string
}

export interface ZoneOption {
  id: number
  zone_number: number
  name: string
}

export interface ChangeLogRow {
  id: number
  entry_id: number
  changed_by: string | null
  changed_at: string
  source: ChangeLogSource
  changes: Record<string, { from: unknown; to: unknown }>
}

export interface AdvanceEntrySummary {
  id: number
  ubbl_number: string
  vendor_display_name: string | null
  vendor_raw: string | null
  amount: number | null
  date: string | null
}
