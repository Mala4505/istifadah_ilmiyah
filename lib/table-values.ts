import { isValidElement, type ReactNode } from 'react'

/**
 * Plain (non-'use client') helpers that turn a rendered table cell into a
 * value the shared InteractiveTable (components/ui/interactive-table.tsx) can
 * search, filter and sort on. Kept out of the client module on purpose: the
 * Reports DataTable runs as a Server Component and calls these while building
 * rows, and a Server Component can't call a function exported from a
 * 'use client' module (see components/ui/pagination-bar-options.ts).
 */

export type CellValue = string | number | null

/** Visible text of a rendered cell — walks strings, numbers, arrays and
 *  element children. Components that render text from props (not children)
 *  contribute nothing; give such a column an explicit sort value instead. */
export function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'bigint') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join(' ').replace(/\s+/g, ' ').trim()
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; title?: unknown }
    const fromChildren = nodeText(props.children)
    if (fromChildren) return fromChildren
    return typeof props.title === 'string' ? props.title : ''
  }
  return ''
}

/** Plain number / money / percent — digits, Indian grouping, leading ₹/$,
 *  trailing %, leading minus. Same shape the Reports DataTable aligns on. */
const NUMERIC_RE = /^[-−]?[₹$]?\s?[\d,]+(\.\d+)?\s*%?$/
/** "05 Oct 2026", "5 Oct 2026", "2026-10-05" (optionally with a time). */
const DATE_RE = /^(\d{1,2} [A-Z][a-z]{2},? \d{4}|\d{4}-\d{2}-\d{2})(\b.*)?$/

/** Text → a sortable value: numbers and dates become numbers, blanks and
 *  dash placeholders become null (sorted last), everything else stays text. */
export function toCellValue(raw: unknown): CellValue {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const text = String(raw).trim()
  if (text === '' || text === '—' || text === '-' || text === '–') return null
  if (NUMERIC_RE.test(text)) {
    const n = Number(text.replace(/[₹$,%\s]/g, '').replace('−', '-'))
    if (Number.isFinite(n)) return n
  }
  if (DATE_RE.test(text)) {
    const t = Date.parse(text)
    if (!Number.isNaN(t)) return t
  }
  return text
}

/** Rendered cell → value, in one step. */
export function cellValueOf(node: ReactNode): CellValue {
  if (typeof node === 'number') return Number.isFinite(node) ? node : null
  return toCellValue(nodeText(node))
}
