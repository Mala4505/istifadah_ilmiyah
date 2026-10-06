/**
 * Row shapes + pure mappers for /settings/item-catalog. A plain module (no
 * 'use client', no server-only imports) so the loader, the server actions and
 * the client tables can all import from it -- Server Components must never
 * import values from a 'use client' module.
 */

export interface ItemCatalogRow {
  id: number
  itemKey: string
  label: string
  familyId: number | null
  familyLabel: string | null
  category: string | null
  unit: string | null
  isComparable: boolean
  isConfirmed: boolean
  confirmedAt: string | null
  lineCount: number
  vendorCount: number
  pretaxValue: number | null
  lastSeen: string | null
  aliasCount: number
  unconfirmedAliasCount: number
  sampleDescriptions: string[]
}

export interface ItemFamilyOption {
  id: number
  familyKey: string
  label: string
  category: string | null
  isConfirmed: boolean
}

export type LineAssignReason = 'unmatched' | 'size_not_read' | 'low_confidence'

export interface LineToAssignRow {
  /** normalised description -- unique per reason */
  key: string
  reason: LineAssignReason
  rawDescription: string
  aliasId: number | null
  confidence: number | null
  currentItemId: number | null
  currentItemLabel: string | null
  currentFamilyLabel: string | null
  lineCount: number
  vendorCount: number
  pretaxValue: number | null
  lastSeen: string | null
  unit: string | null
}

export const LINE_ASSIGN_REASON_LABEL: Record<LineAssignReason, string> = {
  unmatched: 'No match',
  size_not_read: 'Size not read',
  low_confidence: 'Low confidence',
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function toItemCatalogRow(row: Record<string, unknown>): ItemCatalogRow {
  return {
    id: Number(row.id),
    itemKey: String(row.item_key ?? ''),
    label: String(row.canonical_label ?? ''),
    familyId: num(row.item_family_id),
    familyLabel: str(row.family_label),
    category: str(row.category),
    unit: str(row.unit_normalized),
    isComparable: row.is_comparable !== false,
    isConfirmed: row.is_confirmed === true,
    confirmedAt: str(row.confirmed_at),
    lineCount: num(row.line_count) ?? 0,
    vendorCount: num(row.vendor_count) ?? 0,
    pretaxValue: num(row.pretax_value),
    lastSeen: str(row.last_seen),
    aliasCount: num(row.alias_count) ?? 0,
    unconfirmedAliasCount: num(row.unconfirmed_alias_count) ?? 0,
    sampleDescriptions: Array.isArray(row.sample_descriptions)
      ? row.sample_descriptions.filter((s): s is string => typeof s === 'string')
      : [],
  }
}

const REASONS = new Set<LineAssignReason>(['unmatched', 'size_not_read', 'low_confidence'])

export function toLineToAssignRow(row: Record<string, unknown>): LineToAssignRow | null {
  const reason = row.reason as LineAssignReason
  const raw = str(row.raw_description)
  if (!REASONS.has(reason) || !raw) return null
  return {
    key: `${reason}:${String(row.normalized_description ?? raw)}`,
    reason,
    rawDescription: raw,
    aliasId: num(row.alias_id),
    confidence: num(row.confidence),
    currentItemId: num(row.item_catalog_id),
    currentItemLabel: str(row.canonical_label),
    currentFamilyLabel: str(row.family_label),
    lineCount: num(row.line_count) ?? 0,
    vendorCount: num(row.vendor_count) ?? 0,
    pretaxValue: num(row.pretax_value),
    lastSeen: str(row.last_seen),
    unit: str(row.unit_normalized),
  }
}

/** Most lines first, then biggest value -- the order a reviewer should work the queue. */
export function sortLinesToAssign(rows: LineToAssignRow[]): LineToAssignRow[] {
  return rows.toSorted(
    (a, b) =>
      b.lineCount - a.lineCount ||
      (b.pretaxValue ?? 0) - (a.pretaxValue ?? 0) ||
      a.rawDescription.localeCompare(b.rawDescription),
  )
}

/** "Plumbing › CPVC elbow / bend" style label for pickers. */
export function itemOptionLabel(item: Pick<ItemCatalogRow, 'label' | 'familyLabel'>): string {
  if (!item.familyLabel || item.label.startsWith(item.familyLabel)) return item.label
  return `${item.label} (${item.familyLabel})`
}
