'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Check, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mergeVendor, renameVendor, setVendorConfirmed, unmergeVendor } from '@/lib/actions/admin'

export type VendorRow = {
  id: number
  displayName: string
  normalizedName: string
  gstin: string | null
  clusterGroupId: number | null
  isConfirmed: boolean
}

function matchesQuery(vendor: VendorRow, query: string): boolean {
  if (!query) return true
  return (
    vendor.displayName.toLowerCase().includes(query) ||
    vendor.normalizedName.toLowerCase().includes(query) ||
    (vendor.gstin?.toLowerCase().includes(query) ?? false)
  )
}

export function VendorMergePanel({ vendors }: { vendors: VendorRow[] }) {
  const [vendorList, setVendorList] = useState(vendors)
  const [query, setQuery] = useState('')
  const [mergeSource, setMergeSource] = useState<VendorRow | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftName, setDraftName] = useState('')
  const [isRenaming, startRename] = useTransition()

  useEffect(() => {
    setVendorList(vendors)
  }, [vendors])

  const vendorsById = useMemo(() => {
    const map = new Map<number, VendorRow>()
    for (const vendor of vendorList) map.set(vendor.id, vendor)
    return map
  }, [vendorList])

  const childCountByRootId = useMemo(() => {
    const map = new Map<number, number>()
    for (const vendor of vendorList) {
      if (vendor.clusterGroupId !== null) {
        map.set(vendor.clusterGroupId, (map.get(vendor.clusterGroupId) ?? 0) + 1)
      }
    }
    return map
  }, [vendorList])

  const filteredVendors = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return vendorList
    return vendorList.filter((vendor) => matchesQuery(vendor, normalizedQuery))
  }, [vendorList, query])

  function handleConfirmedChange(vendor: VendorRow, isConfirmed: boolean) {
    const previous = vendor.isConfirmed
    setVendorList((current) => current.map((v) => (v.id === vendor.id ? { ...v, isConfirmed } : v)))
    void (async () => {
      const result = await setVendorConfirmed({ vendorId: vendor.id, isConfirmed })
      if (!result.ok) {
        setVendorList((current) => current.map((v) => (v.id === vendor.id ? { ...v, isConfirmed: previous } : v)))
        toastError(result.error, { context: 'vendor-merge-panel' })
      }
    })()
  }

  function startEditing(vendor: VendorRow) {
    setEditingId(vendor.id)
    setDraftName(vendor.displayName)
  }

  function cancelEditing() {
    setEditingId(null)
    setDraftName('')
  }

  function handleRename(vendor: VendorRow) {
    const next = draftName.trim()
    if (!next || next === vendor.displayName) {
      cancelEditing()
      return
    }
    startRename(async () => {
      const result = await renameVendor({ vendorId: vendor.id, displayName: next })
      if (result.ok) {
        setVendorList((current) =>
          current.map((v) => (v.id === vendor.id ? { ...v, displayName: next } : v)),
        )
        toast.success(`Renamed to "${next}".`)
        cancelEditing()
      } else {
        toastError(result.error, { context: 'vendor-merge-panel' })
      }
    })
  }

  function handleUnmerge(vendor: VendorRow) {
    void (async () => {
      const result = await unmergeVendor({ vendorId: vendor.id })
      if (result.ok) {
        toast.success(`"${vendor.displayName}" is independent again.`)
      } else {
        toastError(result.error, { context: 'vendor-merge-panel' })
      }
    })()
  }

  return (
    <div className="space-y-4">
      <Input
        placeholder="Search vendors by name or GSTIN…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="max-w-sm"
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Vendor</TableHead>
            <TableHead>GSTIN</TableHead>
            <TableHead>Confirmed</TableHead>
            <TableHead>Merge status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredVendors.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center text-muted-foreground">
                No vendors match &quot;{query}&quot;.
              </TableCell>
            </TableRow>
          ) : (
            filteredVendors.map((vendor) => {
              const root = vendor.clusterGroupId !== null ? vendorsById.get(vendor.clusterGroupId) : undefined
              const mergedCount = childCountByRootId.get(vendor.id) ?? 0
              return (
                <TableRow key={vendor.id}>
                  <TableCell>
                    {editingId === vendor.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          value={draftName}
                          onChange={(event) => setDraftName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') handleRename(vendor)
                            if (event.key === 'Escape') cancelEditing()
                          }}
                          disabled={isRenaming}
                          autoFocus
                          className="h-8 max-w-[16rem]"
                          aria-label={`New name for ${vendor.displayName}`}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => handleRename(vendor)}
                          disabled={isRenaming}
                          aria-label="Save name"
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={cancelEditing}
                          disabled={isRenaming}
                          aria-label="Cancel rename"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="group flex items-center gap-1.5">
                        <span>{vendor.displayName}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() => startEditing(vendor)}
                          aria-label={`Rename ${vendor.displayName}`}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{vendor.gstin ?? '—'}</TableCell>
                  <TableCell>
                    <Checkbox
                      checked={vendor.isConfirmed}
                      onCheckedChange={(value) => handleConfirmedChange(vendor, value === true)}
                    />
                  </TableCell>
                  <TableCell>
                    {vendor.clusterGroupId !== null ? (
                      <Badge variant="secondary">
                        Merged → {root?.displayName ?? `#${vendor.clusterGroupId}`}
                      </Badge>
                    ) : mergedCount > 0 ? (
                      <Badge variant="outline">{mergedCount} merged in</Badge>
                    ) : (
                      <span className="text-muted-foreground">Independent</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {vendor.clusterGroupId !== null ? (
                      <Button variant="outline" size="sm" onClick={() => handleUnmerge(vendor)}>
                        Undo merge
                      </Button>
                    ) : (
                      <Button variant="outline" size="sm" onClick={() => setMergeSource(vendor)}>
                        Merge into…
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })
          )}
        </TableBody>
      </Table>
      <MergeDialog source={mergeSource} vendors={vendorList} onClose={() => setMergeSource(null)} />
    </div>
  )
}

function MergeDialog({
  source,
  vendors,
  onClose,
}: {
  source: VendorRow | null
  vendors: VendorRow[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  // Holds the candidate the admin just clicked, while the confirmation step
  // is shown -- distinct from `source`, which the parent owns and which
  // stays fixed for the life of this dialog. Merging only sets
  // `cluster_group_id` on the source row (lib/actions/admin.ts's
  // mergeVendor) and is reversible via "Undo merge", but it immediately
  // reattributes the source's spend and document history to the target in
  // every report and vendor total. A list of near-duplicate vendor names is
  // exactly where a fat-fingered click on the wrong candidate is likely, so
  // -- matching the confirmStep pattern in
  // bulk-resolve-exceptions-dialog.tsx -- the actual mutation is gated
  // behind an explicit confirm rather than firing on click.
  const [pendingTarget, setPendingTarget] = useState<VendorRow | null>(null)
  const [isPending, startTransition] = useTransition()

  const candidates = useMemo(() => {
    if (!source) return []
    const normalizedQuery = query.trim().toLowerCase()
    return vendors
      .filter((vendor) => vendor.id !== source.id && vendor.clusterGroupId === null)
      .filter((vendor) => matchesQuery(vendor, normalizedQuery))
      .slice(0, 20)
  }, [source, vendors, query])

  function handleOpenChange(open: boolean) {
    if (!open) {
      setQuery('')
      setPendingTarget(null)
      onClose()
    }
  }

  function handleConfirmMerge() {
    if (!source || !pendingTarget) return
    const target = pendingTarget
    startTransition(async () => {
      const result = await mergeVendor({ vendorId: source.id, targetVendorId: target.id })
      if (result.ok) {
        toast.success(`Merged "${source.displayName}" into "${target.displayName}".`)
        setQuery('')
        setPendingTarget(null)
        onClose()
      } else {
        toastError(result.error, { context: 'vendor-merge-panel' })
      }
    })
  }

  return (
    <Dialog open={source !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        {pendingTarget ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>
                Merge &quot;{source?.displayName}&quot; into &quot;{pendingTarget.displayName}&quot;?
              </DialogTitle>
              <DialogDescription>
                All spend and document history recorded against &quot;{source?.displayName}&quot; will be
                reattributed to &quot;{pendingTarget.displayName}&quot; in reports and vendor totals.
                &quot;{source?.displayName}&quot; itself isn&rsquo;t deleted, and this can be undone with
                &quot;Undo merge&quot; from the vendor list at any time.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPendingTarget(null)} disabled={isPending}>
                Back
              </Button>
              <Button type="button" variant="destructive" onClick={handleConfirmMerge} disabled={isPending}>
                {isPending ? 'Merging…' : 'Confirm merge'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Merge &quot;{source?.displayName}&quot; into…</DialogTitle>
            </DialogHeader>
            <Input
              placeholder="Search target vendor…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {candidates.length === 0 ? (
                <p className="px-2 py-4 text-sm text-muted-foreground">No candidate vendors found.</p>
              ) : (
                candidates.map((candidate) => (
                  <Button
                    key={candidate.id}
                    type="button"
                    variant="ghost"
                    className="w-full justify-start"
                    onClick={() => setPendingTarget(candidate)}
                  >
                    {candidate.displayName}
                  </Button>
                ))
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
