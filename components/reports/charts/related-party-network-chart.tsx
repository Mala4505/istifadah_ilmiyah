'use client'

import { useMemo, useState, type PointerEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import { useChartWidth } from '@/components/reports/charts/use-chart-width'
import { ChartTooltipPanel, ChartTooltipRow } from '@/components/reports/charts/chart-tooltip-panel'
import type { VendorCluster, VendorSharedIdentityEdgeRow } from '@/lib/reports/surfaces/related-party-gstin'

// reporting-blueprint.md B-07 (flagship): "Best drawn as a network — the
// shape *is* the finding, and a table hides it." No external graph library:
// a small deterministic layout — each cluster's vendors placed evenly around
// a circle sized by vendor count, clusters tiled left-to-right/top-to-bottom
// in a grid. The grid is laid out at the card's measured width
// (useChartWidth, scale 1): as many columns as fit at MIN_CELL wide, cells
// stretched up to MAX_CELL, ring radius shrunk to fit a narrow cell — so 11px
// node labels stay 11px on a phone (2 columns) instead of the whole drawing
// scaling down. Deterministic, no force simulation. Real numeric attributes,
// a pointer-move nearest-node hover lookup with a shadcn-styled tooltip
// (chart-tooltip-panel.tsx), and a required "View as table" twin.
//
// Kept readable at <= MAX_VENDORS vendors by capping to the largest clusters
// (by combined spend) that fit — a cluster is never split across the cap, so
// the shown count can land a little under the cap rather than cut a network
// mid-shape. The caption below the chart states the cap when it bites.

const MAX_VENDORS = 40
const FALLBACK_WIDTH = 576
const MIN_CELL = 150
const MAX_CELL = 240
const PAD = 16
const MIN_NODE_R = 5
const MAX_NODE_R = 17
const MIN_CLUSTER_R = 30
const MAX_CLUSTER_R = 66
const HOVER_RADIUS_SQ = 18 * 18

type LaidOutNode = {
  id: number
  name: string
  spend: number
  clusterId: number
  x: number
  y: number
  r: number
}

type LaidOutEdge = {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
  sharedOn: VendorSharedIdentityEdgeRow['shared_on']
  sharedValue: string
  vendorIdA: number
  vendorIdB: number
}

function layoutClusters(clusters: VendorCluster[], containerWidth: number) {
  const shown: VendorCluster[] = []
  let vendorCount = 0
  for (const cluster of clusters) {
    if (shown.length > 0 && vendorCount + cluster.vendors.length > MAX_VENDORS) continue
    shown.push(cluster)
    vendorCount += cluster.vendors.length
    if (vendorCount >= MAX_VENDORS) break
  }

  // As many columns as fit at MIN_CELL, never more than there are clusters.
  const usable = Math.max(MIN_CELL, containerWidth - PAD * 2)
  const cols = Math.max(1, Math.min(shown.length, Math.floor(usable / MIN_CELL)))
  const rows = Math.max(1, Math.ceil(shown.length / cols))
  const cellW = Math.min(MAX_CELL, usable / cols)
  // Row pitch: room for the ring plus the 11px label under the bottom node.
  const cellH = Math.max(MIN_CELL, Math.min(cellW, 200))
  // Ring radius must leave room for the largest node and its label in a
  // narrow cell.
  const maxRingR = Math.max(MIN_CLUSTER_R, Math.min(cellW, cellH) / 2 - MAX_NODE_R - 14)
  const offsetX = Math.max(PAD, (containerWidth - cols * cellW) / 2)
  const maxSpend = Math.max(1, ...shown.flatMap((c) => c.vendors.map((v) => v.spend)), 1)
  // Shorter node labels in a narrow cell so neighbouring rings' labels
  // don't collide (11px ≈ 6.3px per character).
  const labelChars = cellW < 180 ? 11 : 14
  const labelW = labelChars * 6.3 + 8

  const nodes: LaidOutNode[] = []
  const edges: LaidOutEdge[] = []

  shown.forEach((cluster, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = offsetX + cellW / 2 + col * cellW
    const cy = PAD + cellH / 2 + row * cellH
    const n = cluster.vendors.length
    // 3+ nodes: widen the ring until neighbouring nodes sit at least one
    // label-width apart, so their centred labels don't overprint.
    const clusterR =
      n <= 2
        ? MIN_CLUSTER_R
        : Math.min(MAX_CLUSTER_R, maxRingR, Math.max(MIN_CLUSTER_R + (n - 2) * 7, labelW / (2 * Math.sin(Math.PI / n))))
    const posById = new Map<number, { x: number; y: number }>()

    cluster.vendors.forEach((v, vi) => {
      const angle = (vi / n) * 2 * Math.PI - Math.PI / 2
      const x = n === 1 ? cx : cx + clusterR * Math.cos(angle)
      const y = n === 1 ? cy : cy + clusterR * Math.sin(angle)
      posById.set(v.id, { x, y })
      const r = MIN_NODE_R + (MAX_NODE_R - MIN_NODE_R) * Math.sqrt(v.spend / maxSpend)
      nodes.push({ id: v.id, name: v.name, spend: v.spend, clusterId: cluster.clusterId, x, y, r })
    })

    cluster.edges.forEach((e) => {
      const p1 = posById.get(e.vendorIdA)
      const p2 = posById.get(e.vendorIdB)
      if (!p1 || !p2) return
      edges.push({
        key: `${cluster.clusterId}:${e.vendorIdA}:${e.vendorIdB}:${e.sharedOn}`,
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        sharedOn: e.sharedOn,
        sharedValue: e.sharedValue,
        vendorIdA: e.vendorIdA,
        vendorIdB: e.vendorIdB,
      })
    })
  })

  const width = Math.max(containerWidth, offsetX * 2 + cols * cellW)
  const height = PAD * 2 + rows * cellH
  const cappedVendorCount = clusters.reduce((s, c) => s + c.vendors.length, 0) - vendorCount

  return {
    nodes,
    edges,
    labelChars,
    width,
    height,
    shownClusterCount: shown.length,
    totalClusterCount: clusters.length,
    cappedVendorCount: Math.max(0, cappedVendorCount),
  }
}

const SHARED_ON_LABEL: Record<VendorSharedIdentityEdgeRow['shared_on'], string> = {
  gstin: 'GSTIN',
  phone: 'Phone',
  address: 'Address',
}

export function RelatedPartyNetworkChart({ clusters }: { clusters: VendorCluster[] }) {
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [showTable, setShowTable] = useState(false)
  const [wrapRef, containerWidth] = useChartWidth(FALLBACK_WIDTH)

  const layout = useMemo(() => layoutClusters(clusters, containerWidth), [clusters, containerWidth])

  if (layout.nodes.length === 0) return null

  function nearestNode(relX: number, relY: number): LaidOutNode | null {
    let nearest: LaidOutNode | null = null
    let nearestDistSq = Infinity
    for (const node of layout.nodes) {
      const dx = node.x - relX
      const dy = node.y - relY
      const distSq = dx * dx + dy * dy
      if (distSq < nearestDistSq) {
        nearestDistSq = distSq
        nearest = node
      }
    }
    return nearest && nearestDistSq <= HOVER_RADIUS_SQ + nearest.r * nearest.r ? nearest : null
  }

  function handlePointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    // Scale 1: one viewBox unit per CSS pixel.
    const relX = e.clientX - rect.left
    const relY = e.clientY - rect.top
    setHoverId(nearestNode(relX, relY)?.id ?? null)
  }

  const hoverNode = hoverId != null ? (layout.nodes.find((n) => n.id === hoverId) ?? null) : null
  const tooltipLeftPct = hoverNode ? (hoverNode.x / layout.width) * 100 : 50

  const tableColumns: DataTableColumn<LaidOutNode>[] = [
    {
      key: 'vendor',
      header: 'Vendor',
      render: (n) => (
        <Link href={`/entries?vendor_id=${n.id}`} className="text-primary underline-offset-2 hover:underline">
          {n.name}
        </Link>
      ),
    },
    { key: 'cluster', header: 'Cluster', render: (n) => `#${n.clusterId}` },
    { key: 'spend', header: 'Spend (this event)', align: 'right', render: (n) => formatINRCompact(n.spend) },
  ]

  return (
    <div className="flex flex-col gap-3 motion-safe:animate-chart-in">
      <div ref={wrapRef} className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width={layout.width}
          height={layout.height}
          role="img"
          aria-label={`Related-party network — ${formatNumber(layout.shownClusterCount)} vendor cluster${
            layout.shownClusterCount === 1 ? '' : 's'
          } shown, each vendor sized by spend and linked by a shared GSTIN, phone or address. See the table view below for exact values.`}
          tabIndex={0}
          className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoverId(null)}
        >
          {layout.edges.map((e) => (
            <line
              key={e.key}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              className={cn(
                'stroke-border',
                (hoverId === e.vendorIdA || hoverId === e.vendorIdB) && 'stroke-foreground/60'
              )}
              strokeWidth={1.25}
            >
              <title>
                {SHARED_ON_LABEL[e.sharedOn]}: {e.sharedValue}
              </title>
            </line>
          ))}

          {layout.nodes.map((n) => {
            const isHovered = hoverId === n.id
            const label = `${n.name}: ${formatINRCompact(n.spend)} this event, cluster #${n.clusterId}`
            return (
              <Link
                key={n.id}
                href={`/entries?vendor_id=${n.id}`}
                aria-label={label}
                className="cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <title>{label}</title>
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={n.r}
                  strokeWidth={isHovered ? 2 : 1}
                  className={cn(
                    'fill-[#2a78d6] dark:fill-[#3987e5]',
                    isHovered ? 'stroke-card' : 'stroke-background'
                  )}
                />
                <text
                  x={n.x}
                  y={n.y + n.r + 12}
                  textAnchor="middle"
                  className={cn('fill-muted-foreground text-[11px]', isHovered && 'fill-foreground font-medium')}
                >
                  {n.name.length > layout.labelChars ? `${n.name.slice(0, layout.labelChars - 1)}…` : n.name}
                </text>
              </Link>
            )
          })}
        </svg>

        {hoverNode && (
          <ChartTooltipPanel leftPct={tooltipLeftPct} className="min-w-[10rem]" title={hoverNode.name}>
            <ChartTooltipRow
              label="Spend (this event)"
              value={formatINRCompact(hoverNode.spend)}
              indicatorClass="bg-[#2a78d6] dark:bg-[#3987e5]"
            />
            <ChartTooltipRow label="Cluster" value={`#${hoverNode.clusterId}`} />
          </ChartTooltipPanel>
        )}
      </div>

      {layout.cappedVendorCount > 0 && (
        <p className="text-xs text-muted-foreground">
          Showing the {formatNumber(layout.shownClusterCount)} largest cluster
          {layout.shownClusterCount === 1 ? '' : 's'} by combined spend, of {formatNumber(layout.totalClusterCount)}{' '}
          total — {formatNumber(layout.cappedVendorCount)} more vendor{layout.cappedVendorCount === 1 ? '' : 's'} in
          smaller clusters not pictured here. Every cluster&rsquo;s edges are still listed in the table beneath the
          chart on this page.
        </p>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Hide table' : 'View as table'}
        </Button>
      </div>
      {showTable && <DataTable columns={tableColumns} rows={layout.nodes} getRowKey={(n) => n.id} />}
    </div>
  )
}
