'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { acceptVendorCluster, dismissVendorCluster } from '@/lib/actions/vendor-clusters'
import {
  CLUSTER_REASON_LABEL,
  type ProposalVendor,
  type VendorClusterProposal,
} from '@/lib/vendor-clusters/group'

const PAGE_SIZE = 10

/**
 * Settings -> Vendors: automatic vendor-cluster proposals (shared GSTIN / PAN,
 * phone, address, or near-duplicate name). Proposes only -- nothing is merged
 * until an admin accepts. Accept sets cluster_group_id on every included
 * member except the chosen main vendor; Dismiss records the group as "not the
 * same" so it stops being proposed.
 */
export function VendorClusterProposals({ proposals }: { proposals: VendorClusterProposal[] }) {
  const [handledKeys, setHandledKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const open = useMemo(() => proposals.filter((p) => !handledKeys.has(p.key)), [proposals, handledKeys])

  function markHandled(key: string) {
    setHandledKeys((current) => new Set(current).add(key))
  }

  if (open.length === 0) {
    return <p className="text-sm text-muted-foreground">No possible duplicates to review right now.</p>
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {open.length} possible duplicate group{open.length === 1 ? '' : 's'}, strongest evidence first.
      </p>
      {open.slice(0, visibleCount).map((proposal) => (
        <ProposalCard key={proposal.key} proposal={proposal} onHandled={() => markHandled(proposal.key)} />
      ))}
      {open.length > visibleCount ? (
        <Button variant="outline" size="sm" onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
          Show {Math.min(PAGE_SIZE, open.length - visibleCount)} more
        </Button>
      ) : null}
    </div>
  )
}

function ProposalCard({ proposal, onHandled }: { proposal: VendorClusterProposal; onHandled: () => void }) {
  const [rootId, setRootId] = useState(proposal.suggestedRootId)
  const [included, setIncluded] = useState<ReadonlySet<number>>(() => new Set(proposal.vendors.map((v) => v.id)))
  const [confirming, setConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  const vendorsById = useMemo(() => new Map(proposal.vendors.map((v) => [v.id, v])), [proposal.vendors])
  const root = vendorsById.get(rootId)!
  const mergeCount = proposal.vendors.filter((v) => v.id !== rootId && included.has(v.id)).length

  function toggleIncluded(vendorId: number, value: boolean) {
    setIncluded((current) => {
      const next = new Set(current)
      if (value) next.add(vendorId)
      else next.delete(vendorId)
      return next
    })
  }

  function handleAccept() {
    const memberVendorIds = proposal.vendors.filter((v) => v.id === rootId || included.has(v.id)).map((v) => v.id)
    startTransition(async () => {
      const result = await acceptVendorCluster({ rootVendorId: rootId, memberVendorIds })
      if (result.ok) {
        toast.success(`Merged ${mergeCount} vendor${mergeCount === 1 ? '' : 's'} into "${root.displayName}".`)
        setConfirming(false)
        onHandled()
      } else {
        toastError(result.error, { context: 'vendor-cluster-proposals' })
      }
    })
  }

  function handleDismiss() {
    startTransition(async () => {
      const result = await dismissVendorCluster({ vendorIds: proposal.vendors.map((v) => v.id) })
      if (result.ok) {
        toast.success('Marked as different vendors. This group will not be suggested again.')
        onHandled()
      } else {
        toastError(result.error, { context: 'vendor-cluster-proposals' })
      }
    })
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {proposal.reasons.map((reason) => (
            <Badge key={reason} variant={reason === 'similar_name' ? 'outline' : 'secondary'}>
              {CLUSTER_REASON_LABEL[reason]}
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleDismiss} disabled={isPending}>
            Not the same
          </Button>
          <Button size="sm" onClick={() => setConfirming(true)} disabled={isPending || mergeCount === 0}>
            Merge…
          </Button>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Main</TableHead>
            <TableHead className="w-16">Include</TableHead>
            <TableHead>Vendor</TableHead>
            <TableHead>GSTIN</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Address</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proposal.vendors.map((vendor) => (
            <MemberRow
              key={vendor.id}
              vendor={vendor}
              groupKey={proposal.key}
              isRoot={vendor.id === rootId}
              isIncluded={included.has(vendor.id)}
              disabled={isPending}
              onPickRoot={() => setRootId(vendor.id)}
              onIncludedChange={(value) => toggleIncluded(vendor.id, value)}
            />
          ))}
        </TableBody>
      </Table>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Why</TableHead>
            <TableHead>Between</TableHead>
            <TableHead>Shared value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {proposal.edges.map((edge) => (
            <TableRow key={`${edge.vendorIdA}-${edge.vendorIdB}-${edge.reason}`}>
              <TableCell>{CLUSTER_REASON_LABEL[edge.reason]}</TableCell>
              <TableCell>
                {vendorsById.get(edge.vendorIdA)?.displayName} &amp; {vendorsById.get(edge.vendorIdB)?.displayName}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {edge.detail ?? '—'}
                {edge.score !== null ? ` (${Math.round(edge.score * 100)}% alike)` : ''}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Dialog open={confirming} onOpenChange={(value) => {
          if (!isPending) setConfirming(value)
        }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Merge {mergeCount} vendor{mergeCount === 1 ? '' : 's'} into &quot;{root.displayName}&quot;?
            </DialogTitle>
            <DialogDescription>
              Their spend and document history will be counted under &quot;{root.displayName}&quot; in reports and
              vendor totals. Nothing is deleted, and each can be undone with &quot;Undo merge&quot; in the vendor
              list below.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={isPending}>
              Back
            </Button>
            <Button variant="destructive" onClick={handleAccept} disabled={isPending}>
              {isPending ? 'Merging…' : 'Confirm merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function MemberRow({
  vendor,
  groupKey,
  isRoot,
  isIncluded,
  disabled,
  onPickRoot,
  onIncludedChange,
}: {
  vendor: ProposalVendor
  groupKey: string
  isRoot: boolean
  isIncluded: boolean
  disabled: boolean
  onPickRoot: () => void
  onIncludedChange: (value: boolean) => void
}) {
  return (
    <TableRow>
      <TableCell>
        <input
          type="radio"
          name={`cluster-root-${groupKey}`}
          checked={isRoot}
          onChange={onPickRoot}
          disabled={disabled}
          className="h-4 w-4 accent-primary"
          aria-label={`Keep ${vendor.displayName} as the main vendor`}
        />
      </TableCell>
      <TableCell>
        <Checkbox
          checked={isRoot || isIncluded}
          disabled={disabled || isRoot}
          onCheckedChange={(value) => onIncludedChange(value === true)}
          aria-label={`Include ${vendor.displayName} in the merge`}
        />
      </TableCell>
      <TableCell>
        <span>{vendor.displayName}</span>
        {vendor.isConfirmed ? (
          <Badge variant="outline" className="ml-2">
            Confirmed
          </Badge>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-xs">{vendor.gstin ?? '—'}</TableCell>
      <TableCell>{vendor.phone ?? '—'}</TableCell>
      <TableCell className="max-w-[18rem] truncate" title={vendor.address ?? undefined}>
        {vendor.address ?? '—'}
      </TableCell>
    </TableRow>
  )
}
