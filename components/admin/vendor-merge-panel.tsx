'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { mergeVendor, setVendorConfirmed, unmergeVendor } from '@/lib/actions/admin'

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
                  <TableCell>{vendor.displayName}</TableCell>
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
      onClose()
    }
  }

  function handleSelect(target: VendorRow) {
    if (!source) return
    startTransition(async () => {
      const result = await mergeVendor({ vendorId: source.id, targetVendorId: target.id })
      if (result.ok) {
        toast.success(`Merged "${source.displayName}" into "${target.displayName}".`)
        setQuery('')
        onClose()
      } else {
        toastError(result.error, { context: 'vendor-merge-panel' })
      }
    })
  }

  return (
    <Dialog open={source !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
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
                disabled={isPending}
                onClick={() => handleSelect(candidate)}
              >
                {candidate.displayName}
              </Button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
