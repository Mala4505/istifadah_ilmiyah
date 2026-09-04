'use client'

import { useMemo, useState, type PointerEvent } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import { barLeftClass } from '@/lib/reports/bar-scale'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { Button } from '@/components/ui/button'
import type { VendorCluster, VendorSharedIdentityEdgeRow } from '@/lib/reports/surfaces/related-party-gstin'

// reporting-blueprint.md B-07 (flagship): "Best drawn as a network — the
// shape *is* the finding, and a table hides it." No external graph library:
// a small deterministic layout — each cluster's vendors placed evenly around
// a circle sized by vendor count, clusters tiled left-to-right/top-to-bottom
// in a grid. Structurally mirrors attention-map-chart.tsx / heatmap-matrix-chart.tsx:
// inline SVG with real numeric attributes (exempt from this app's style-src
// CSP constraint — see lib/reports/bar-scale.ts), a pointer-move nearest-node
// hover lookup, and a required "View as table" twin.
//
// Kept readable at <= MAX_VENDORS vendors by capping to the largest clusters
// (by combined spend) that fit — a cluster is never split across the cap, so
// the shown count can land a little under the cap rather than cut a network
// mid-shape. The caption below the chart states the cap when it bites.

const MAX_VENDORS = 40
const CELL = 176
const PAD = 24
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

function layoutClusters(clusters: VendorCluster[]) {
  const shown: VendorCluster[] = []
  let vendorCount = 0
  for (const cluster of clusters) {
    if (shown.length > 0 && vendorCount + cluster.vendors.length > MAX_VENDORS) continue
    shown.push(cluster)
    vendorCount += cluster.vendors.length
    if (vendorCount >= MAX_VENDORS) break
  }

  const cols = Math.max(1, Math.ceil(Math.sqrt(shown.length)))
  const rows = Math.max(1, Math.ceil(shown.length / cols))
  const maxSpend = Math.max(1, ...shown.flatMap((c) => c.vendors.map((v) => v.spend)), 1)

  const nodes: LaidOutNode[] = []
  const edges: LaidOutEdge[] = []

  shown.forEach((cluster, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = PAD + CELL / 2 + col * CELL
    const cy = PAD + CELL / 2 + row * CELL
    const n = cluster.vendors.length
    const clusterR = n <= 2 ? MIN_CLUSTER_R : Math.min(MAX_CLUSTER_R, MIN_CLUSTER_R + (n - 2) * 7)
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

  const width = PAD * 2 + cols * CELL
  const height = PAD * 2 + rows * CELL
  const cappedVendorCount = clusters.reduce((s, c) => s + c.vendors.length, 0) - vendorCount

  return {
    nodes,
    edges,
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

  const layout = useMemo(() => layoutClusters(clusters), [clusters])

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
    const relX = ((e.clientX - rect.left) / rect.width) * layout.width
    const relY = ((e.clientY - rect.top) / rect.height) * layout.height
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
    <div className="flex flex-col gap-3">
      <div className="relative w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          width="100%"
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
                  y={n.y + n.r + 10}
                  textAnchor="middle"
                  className={cn('fill-muted-foreground text-[8px]', isHovered && 'fill-foreground font-medium')}
                >
                  {n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}
                </text>
              </Link>
            )
          })}
        </svg>

        {hoverNode && (
          <div
            className={cn(
              'pointer-events-none absolute top-1 z-10 min-w-[10rem] -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md',
              barLeftClass(tooltipLeftPct)
            )}
          >
            <p className="mb-1 font-medium text-foreground">{hoverNode.name}</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Spend (this event)</span>
              <span className="font-mono font-semibold text-foreground">{formatINRCompact(hoverNode.spend)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Cluster</span>
              <span className="font-mono font-semibold text-foreground">#{hoverNode.clusterId}</span>
            </div>
          </div>
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
