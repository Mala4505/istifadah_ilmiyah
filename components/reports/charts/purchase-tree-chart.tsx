'use client'

import { useState } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatINR, formatINRCompact, formatNumber } from '@/lib/reports/format'
import { barWidthClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import type { PurchaseTreeRow } from '@/lib/reports/surfaces/purchase-tree'

// reporting-blueprint.md C-02 (flagship) §4: "Drillable tree: family → item →
// vendor → bill. The only view in the product that answers 'what did we
// actually buy', and the natural home for a live drill-down demo."
//
// Every level is rolled up client-side from the flat v_purchase_tree rows —
// no per-level query. Rows already read as label + rupee figure + a share
// bar, so this tree already IS the "view as table" the dataviz skill asks
// every chart to carry; the toggle below still offers a fully-flat,
// non-nested table for parity with every other chart in this app and for
// anyone who wants to sort/scan raw observations instead of drilling.
//
// Rendered as nested <button>s (not a hand-rolled div+onKeyDown tree) so
// Tab/Shift+Tab, Enter and Space all work for free; each carries
// aria-expanded and a full aria-label (label, rolled-up spend, child count)
// since the disclosure triangle glyph alone conveys nothing to a screen
// reader. A bill node with a resolvable entry_id renders as a next/link
// instead of a button — it has nothing left to expand, only somewhere to go.

type TreeLevel = 'family' | 'catalog' | 'vendor' | 'bill'

type TreeNode = {
  key: string
  level: TreeLevel
  label: string
  spend: number
  observationCount: number
  children: TreeNode[]
  entryId: number | null
  invoiceNumber: string | null
}

const UNCLASSIFIED_CATALOG_LABEL = 'Unclassified item'
const UNKNOWN_VENDOR_LABEL = 'Unknown vendor'
const NO_ENTRY_LABEL = 'No linked entry'

const CHILD_NOUN: Record<TreeLevel, string> = {
  family: 'catalogue item',
  catalog: 'vendor',
  vendor: 'bill',
  bill: 'line item',
}

function childCountLabel(node: TreeNode): string {
  const count = node.level === 'bill' ? node.observationCount : node.children.length
  const noun = CHILD_NOUN[node.level]
  return `${formatNumber(count)} ${noun}${count === 1 ? '' : 's'}`
}

/** Groups a flat row list by a key fn, summing line_amount and counting rows
 *  into each group, preserving insertion order of first sight then sorting
 *  the caller's way. */
function groupRows<K>(
  rows: PurchaseTreeRow[],
  keyOf: (r: PurchaseTreeRow) => K
): Map<K, PurchaseTreeRow[]> {
  const map = new Map<K, PurchaseTreeRow[]>()
  for (const r of rows) {
    const k = keyOf(r)
    const bucket = map.get(k)
    if (bucket) bucket.push(r)
    else map.set(k, [r])
  }
  return map
}

function sumLineAmount(rows: PurchaseTreeRow[]): number {
  return rows.reduce((s, r) => s + (r.line_amount ?? 0), 0)
}

function buildBillNodes(rows: PurchaseTreeRow[], pathPrefix: string): TreeNode[] {
  const withEntry = rows.filter((r) => r.entry_id != null)
  const withoutEntry = rows.filter((r) => r.entry_id == null)

  const byEntry = groupRows(withEntry, (r) => r.entry_id as number)
  const nodes: TreeNode[] = [...byEntry.entries()].map(([entryId, entryRows]) => ({
    key: `${pathPrefix}>bill:${entryId}`,
    level: 'bill',
    label: entryRows[0]!.invoice_number ? `Invoice ${entryRows[0]!.invoice_number}` : `Entry #${entryId}`,
    spend: sumLineAmount(entryRows),
    observationCount: entryRows.length,
    children: [],
    entryId,
    invoiceNumber: entryRows[0]!.invoice_number,
  }))

  if (withoutEntry.length > 0) {
    nodes.push({
      key: `${pathPrefix}>bill:none`,
      level: 'bill',
      label: NO_ENTRY_LABEL,
      spend: sumLineAmount(withoutEntry),
      observationCount: withoutEntry.length,
      children: [],
      entryId: null,
      invoiceNumber: null,
    })
  }

  return nodes.sort((a, b) => b.spend - a.spend)
}

function buildVendorNodes(rows: PurchaseTreeRow[], pathPrefix: string): TreeNode[] {
  const byVendor = groupRows(rows, (r) => r.vendor_id ?? -1)
  const nodes: TreeNode[] = [...byVendor.entries()].map(([vendorId, vendorRows]) => {
    const key = `${pathPrefix}>vendor:${vendorId}`
    return {
      key,
      level: 'vendor',
      label: vendorId === -1 ? UNKNOWN_VENDOR_LABEL : (vendorRows[0]!.vendor_display_name ?? `Vendor #${vendorId}`),
      spend: sumLineAmount(vendorRows),
      observationCount: vendorRows.length,
      children: buildBillNodes(vendorRows, key),
      entryId: null,
      invoiceNumber: null,
    }
  })
  return nodes.sort((a, b) => b.spend - a.spend)
}

function buildCatalogNodes(rows: PurchaseTreeRow[], pathPrefix: string): TreeNode[] {
  const byCatalog = groupRows(rows, (r) => r.item_catalog_id ?? -1)
  const nodes: TreeNode[] = [...byCatalog.entries()].map(([catalogId, catalogRows]) => {
    const key = `${pathPrefix}>catalog:${catalogId}`
    return {
      key,
      level: 'catalog',
      label: catalogId === -1 ? UNCLASSIFIED_CATALOG_LABEL : (catalogRows[0]!.catalog_label ?? `Item #${catalogId}`),
      spend: sumLineAmount(catalogRows),
      observationCount: catalogRows.length,
      children: buildVendorNodes(catalogRows, key),
      entryId: null,
      invoiceNumber: null,
    }
  })
  return nodes.sort((a, b) => b.spend - a.spend)
}

function buildFamilyNodes(rows: PurchaseTreeRow[]): TreeNode[] {
  const byFamily = groupRows(rows, (r) => r.item_family_id)
  const nodes: TreeNode[] = [...byFamily.entries()].map(([familyId, familyRows]) => {
    const key = `family:${familyId}`
    return {
      key,
      level: 'family',
      label: familyRows[0]!.family_label,
      spend: sumLineAmount(familyRows),
      observationCount: familyRows.length,
      children: buildCatalogNodes(familyRows, key),
      entryId: null,
      invoiceNumber: null,
    }
  })
  return nodes.sort((a, b) => b.spend - a.spend)
}

const LEVEL_INDENT: Record<TreeLevel, string> = {
  family: 'pl-2',
  catalog: 'pl-7',
  vendor: 'pl-12',
  bill: 'pl-[4.25rem]',
}

const LEVEL_ARIA: Record<TreeLevel, number> = { family: 1, catalog: 2, vendor: 3, bill: 4 }

function TreeRowLabel({ node, grandTotal, expanded }: { node: TreeNode; grandTotal: number; expanded: boolean }) {
  const pct = grandTotal > 0 ? (node.spend / grandTotal) * 100 : 0
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-3 text-left">
      {node.level !== 'bill' && (
        <ChevronRight
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
          aria-hidden="true"
        />
      )}
      <span className={cn('min-w-0 flex-1 truncate text-sm text-foreground', node.level === 'family' && 'font-medium')}>
        {node.label}
      </span>
      <span className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
          <span className={cn('block h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]', barWidthClass(pct))} />
        </span>
      </span>
      <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
        {childCountLabel(node)}
      </span>
      <span className="w-24 shrink-0 text-right font-mono text-sm font-semibold tabular-nums text-foreground">
        {formatINRCompact(node.spend)}
      </span>
    </div>
  )
}

function TreeRow({
  node,
  grandTotal,
  expandedKeys,
  onToggle,
}: {
  node: TreeNode
  grandTotal: number
  expandedKeys: Set<string>
  onToggle: (key: string) => void
}) {
  const expanded = expandedKeys.has(node.key)

  if (node.level === 'bill') {
    const content = <TreeRowLabel node={node} grandTotal={grandTotal} expanded={false} />
    return (
      <li
        role="treeitem"
        aria-selected={false}
        aria-level={LEVEL_ARIA.bill}
        className={cn('border-b border-border/40 last:border-0', LEVEL_INDENT.bill)}
      >
        {node.entryId != null ? (
          <Link
            href={`/entries/${node.entryId}`}
            className="flex w-full items-center rounded-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${node.label}, ${formatINR(node.spend)}, ${childCountLabel(node)} — open this entry`}
          >
            {content}
          </Link>
        ) : (
          <div className="flex w-full items-center opacity-80" aria-label={`${node.label}, ${formatINR(node.spend)}, ${childCountLabel(node)}`}>
            {content}
          </div>
        )}
      </li>
    )
  }

  return (
    <li
      role="treeitem"
      aria-selected={false}
      aria-expanded={expanded}
      aria-level={LEVEL_ARIA[node.level]}
      className="border-b border-border/40 last:border-0"
    >
      <button
        type="button"
        onClick={() => onToggle(node.key)}
        aria-expanded={expanded}
        aria-label={`${node.label}, ${formatINR(node.spend)}, ${childCountLabel(node)}${expanded ? ', expanded' : ', collapsed'}`}
        className={cn(
          'flex w-full items-center rounded-sm hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          LEVEL_INDENT[node.level]
        )}
      >
        <TreeRowLabel node={node} grandTotal={grandTotal} expanded={expanded} />
      </button>
      {expanded && node.children.length > 0 && (
        <ul role="group">
          {node.children.map((child) => (
            <TreeRow key={child.key} node={child} grandTotal={grandTotal} expandedKeys={expandedKeys} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  )
}

export function PurchaseTreeChart({ rows }: { rows: PurchaseTreeRow[] }) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const [showTable, setShowTable] = useState(false)

  if (rows.length === 0) return null

  const familyNodes = buildFamilyNodes(rows)
  const grandTotal = sumLineAmount(rows)

  function toggle(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Sorting + indexing 1k rows is cheap, but only worth doing once the
  // toggle below is actually open.
  const flatTableRows = showTable ? [...rows].sort((a, b) => b.line_amount - a.line_amount) : []
  const rowIndex = showTable ? new Map(flatTableRows.map((r, i) => [r, i])) : null

  const flatColumns: DataTableColumn<PurchaseTreeRow>[] = [
    { key: 'family', header: 'Item family', render: (r) => r.family_label },
    { key: 'catalog', header: 'Catalogue item', render: (r) => r.catalog_label ?? UNCLASSIFIED_CATALOG_LABEL },
    {
      key: 'vendor',
      header: 'Vendor',
      render: (r) =>
        r.vendor_id ? (
          <Link href={`/entries?vendor_id=${r.vendor_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.vendor_display_name ?? `#${r.vendor_id}`}
          </Link>
        ) : (
          (r.vendor_display_name ?? UNKNOWN_VENDOR_LABEL)
        ),
    },
    {
      key: 'entry',
      header: 'Bill',
      render: (r) =>
        r.entry_id ? (
          <Link href={`/entries/${r.entry_id}`} className="text-primary underline-offset-2 hover:underline">
            {r.invoice_number ? r.invoice_number : `#${r.entry_id}`}
          </Link>
        ) : (
          NO_ENTRY_LABEL
        ),
    },
    { key: 'rate', header: 'Net rate', align: 'right', render: (r) => formatINR(r.net_rate) },
    { key: 'qty', header: 'Qty', align: 'right', render: (r) => formatNumber(r.quantity) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.line_amount) },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-border pb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
        <span className="flex-1">Family → catalogue item → vendor → bill</span>
        <span className="hidden w-16 text-right sm:block">Share</span>
        <span className="w-16 text-right">Children</span>
        <span className="w-24 text-right">Spend</span>
      </div>
      <ul role="tree" aria-label="Purchase tree — family, catalogue item, vendor, then bill; expand a row to drill down" className="flex flex-col">
        {familyNodes.map((node) => (
          <TreeRow key={node.key} node={node} grandTotal={grandTotal} expandedKeys={expandedKeys} onToggle={toggle} />
        ))}
      </ul>

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide flat table' : 'View as flat table'}
        </Button>
      </div>
      {showTable && (
        <DataTable
          columns={flatColumns}
          rows={flatTableRows}
          // DataTable calls getRowKey(row) with no index, and a row here
          // carries no unique id of its own (v_purchase_tree is
          // observation-grain with no rate_reference_id in its output) — so
          // the position is captured once, by object reference, into
          // rowIndex above rather than re-derived from row contents (which
          // could collide across two genuinely identical observations).
          getRowKey={(r) => rowIndex?.get(r) ?? 0}
        />
      )}
    </div>
  )
}
