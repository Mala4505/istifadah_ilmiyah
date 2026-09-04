import Link from 'next/link'
import { ReportSection } from '@/components/reports/report-section'
import { EmptyState } from '@/components/reports/empty-state'
import { DataTable, type DataTableColumn } from '@/components/reports/data-table'
import { ExportCsvButton } from '@/components/reports/export-csv-button'
import { KpiTile } from '@/components/reports/charts/kpi-tile'
import { RelatedPartyNetworkChart } from '@/components/reports/charts/related-party-network-chart'
import { toCsv } from '@/lib/reports/csv'
import { formatINRCompact, formatNumber } from '@/lib/reports/format'
import type { VendorCluster, VendorSharedIdentityEdgeRow } from '@/lib/reports/surfaces/related-party-gstin'

// reporting-blueprint.md B-07 (flagship) — related-party cluster map.
// "Distinct vendor names sharing a GSTIN, phone number or address. Best
// drawn as a network — the shape *is* the finding, and a table hides it."
// No prior-period comparison: vendor identity has no event axis (see the
// loader's header), so the KpiTile's `delta` slot carries "N vendors
// involved" instead of a period-over-period figure.

const SHARED_ON_LABEL: Record<VendorSharedIdentityEdgeRow['shared_on'], string> = {
  gstin: 'GSTIN',
  phone: 'Phone',
  address: 'Address',
}

/** "N clusters span M vendor names that share an identity — the largest,
 *  led by {vendor}, combines K vendor names behind ₹X of spend." (§6 fix #3) */
export function relatedPartyClustersSentence(clusters: VendorCluster[]): string {
  if (clusters.length === 0) {
    return 'No two vendor names currently share a GSTIN, phone number or address — nothing to cluster yet.'
  }
  const vendorsInvolved = clusters.reduce((s, c) => s + c.vendors.length, 0)
  const largest = clusters[0]! // buildVendorClusters sorts by combinedSpend descending
  const lead = largest.vendors[0]! // sorted by spend descending within the cluster
  return (
    `${formatNumber(clusters.length)} cluster${clusters.length === 1 ? '' : 's'} span ${formatNumber(
      vendorsInvolved
    )} vendor name${vendorsInvolved === 1 ? '' : 's'} that share an identity — the largest, led by ${lead.name}, ` +
    `combines ${formatNumber(largest.vendors.length)} vendor names behind ${formatINRCompact(
      largest.combinedSpend
    )} of this event's spend.`
  )
}

export function RelatedPartyClustersSection({
  edges,
  clusters,
  error,
}: {
  edges: VendorSharedIdentityEdgeRow[]
  clusters: VendorCluster[]
  error: string | null
}) {
  const vendorsInvolved = clusters.reduce((s, c) => s + c.vendors.length, 0)

  const columns: DataTableColumn<VendorSharedIdentityEdgeRow>[] = [
    {
      key: 'vendorA',
      header: 'Vendor A',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id_a}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_name_a}
        </Link>
      ),
    },
    {
      key: 'vendorB',
      header: 'Vendor B',
      render: (r) => (
        <Link href={`/entries?vendor_id=${r.vendor_id_b}`} className="text-primary underline-offset-2 hover:underline">
          {r.vendor_name_b}
        </Link>
      ),
    },
    { key: 'sharedOn', header: 'Shared on', render: (r) => SHARED_ON_LABEL[r.shared_on] },
    { key: 'sharedValue', header: 'Shared value', render: (r) => r.shared_value },
  ]

  const tableRows = [...edges].sort((a, b) => a.shared_on.localeCompare(b.shared_on) || a.vendor_id_a - b.vendor_id_a)

  return (
    <ReportSection
      id="related-party-clusters"
      title="Related-party cluster map"
      description="Distinct vendor names sharing a GSTIN, phone number or address — a network, because the shape of who's connected to whom is the finding a table would hide. Vendor identity has no event axis, so this covers every event's vendors; each vendor's spend figure is still this event's."
      action={
        <ExportCsvButton
          filename="related-party-clusters.csv"
          rowCount={edges.length}
          csv={toCsv(edges, [
            { header: 'Vendor A', value: (r) => r.vendor_name_a },
            { header: 'Vendor A ID', value: (r) => r.vendor_id_a },
            { header: 'Vendor B', value: (r) => r.vendor_name_b },
            { header: 'Vendor B ID', value: (r) => r.vendor_id_b },
            { header: 'Shared on', value: (r) => SHARED_ON_LABEL[r.shared_on] },
            { header: 'Shared value', value: (r) => r.shared_value },
          ])}
        />
      }
    >
      {error ? (
        <EmptyState title="Couldn't load related-party clusters" description={error} />
      ) : clusters.length === 0 ? (
        <EmptyState
          title="No shared-identity clusters"
          description="This fills in when two or more vendor names share a non-blank GSTIN, phone number or address — usually the same supplier entered under slightly different names."
        />
      ) : (
        <>
          <KpiTile
            label="Related-party clusters found"
            value={formatNumber(clusters.length)}
            delta={`${formatNumber(vendorsInvolved)} vendor${vendorsInvolved === 1 ? '' : 's'} involved`}
            deltaTone="neutral"
          />
          <p className="text-sm text-muted-foreground">{relatedPartyClustersSentence(clusters)}</p>
          <RelatedPartyNetworkChart clusters={clusters} />
          <DataTable
            columns={columns}
            rows={tableRows}
            getRowKey={(r) => `${r.vendor_id_a}:${r.vendor_id_b}:${r.shared_on}`}
            emptyTitle="No shared-identity edges"
          />
        </>
      )}
    </ReportSection>
  )
}
