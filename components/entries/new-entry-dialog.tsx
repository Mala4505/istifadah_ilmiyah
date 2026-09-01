'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SelectNative } from '@/components/ui/select-native'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { createManualEntry } from '@/lib/actions/entries'
import type { LookupOption } from './types'

/**
 * The typing path into `entries`, for departments that key their bills in
 * rather than importing them (confirmed 2026-08-19). Deliberately short: the
 * fields the Departmental import would have supplied, and nothing else. Hub
 * enrichment (admin head, zone, cost centre) and Hub status are set afterwards
 * on the entry detail screen, exactly as they are for an imported entry —
 * there is no separate "manual entry" lifecycle to learn.
 *
 * The department is shown but not editable when the signed-in account is
 * scoped to exactly one: that account has exactly one legitimate answer, and
 * the server resolves it from `staff_department` regardless of what this
 * form sends. A `dept` account assigned several departments (confirmed
 * 2026-08-19: a dept user may hold multiple) picks among just its own; an
 * all-departments account (admin/superadmin) gets the full picker.
 */
const ENTRY_TYPES = [
  { value: 'invoice', label: 'Invoice' },
  { value: 'reimbursement', label: 'Reimbursement' },
  { value: 'advance_payment', label: 'Advance payment' },
] as const

export function NewEntryDialog({
  departments,
  budgetHeads,
  ownDepartmentIds,
  onCreated,
}: {
  departments: LookupOption[]
  budgetHeads: LookupOption[]
  /** Empty = an all-departments account, which must pick a department itself.
   *  Exactly one = locked to that department. More than one = must pick among just those. */
  ownDepartmentIds: number[]
  onCreated: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const lockedDepartmentId = ownDepartmentIds.length === 1 ? ownDepartmentIds[0]! : null
  const [departmentId, setDepartmentId] = useState<number | null>(lockedDepartmentId)
  const [type, setType] = useState<(typeof ENTRY_TYPES)[number]['value']>('invoice')
  const [vendorName, setVendorName] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [date, setDate] = useState('')
  const [amount, setAmount] = useState('')
  const [budgetHeadId, setBudgetHeadId] = useState<number | null>(null)
  const [remark, setRemark] = useState('')

  const effectiveDepartmentId = lockedDepartmentId ?? departmentId
  const lockedDepartmentName = useMemo(
    () => (lockedDepartmentId === null ? null : (departments.find((d) => d.id === lockedDepartmentId)?.label ?? null)),
    [departments, lockedDepartmentId]
  )
  // A multi-department dept user picks among just their own departments; an
  // admin/superadmin (ownDepartmentIds empty) picks from every department.
  const selectableDepartments = useMemo(
    () => (ownDepartmentIds.length > 1 ? departments.filter((d) => ownDepartmentIds.includes(d.id)) : departments),
    [departments, ownDepartmentIds]
  )

  // Budget heads are department-scoped (some are org-wide, with a null
  // department_id) — showing another department's heads would only invite a
  // wrong pick that RLS then rejects at save time.
  const selectableBudgetHeads = useMemo(
    () =>
      budgetHeads.filter(
        (b) =>
          b.department_id === null ||
          b.department_id === undefined ||
          b.department_id === effectiveDepartmentId
      ),
    [budgetHeads, effectiveDepartmentId]
  )

  function resetForm() {
    setDepartmentId(lockedDepartmentId)
    setType('invoice')
    setVendorName('')
    setInvoiceNumber('')
    setDate('')
    setAmount('')
    setBudgetHeadId(null)
    setRemark('')
  }

  async function handleSubmit() {
    const parsedAmount = Number(amount.replace(/,/g, ''))
    if (!vendorName.trim()) {
      toast.error('Enter the vendor or payee name.')
      return
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error('Enter the amount as a number, more than zero.')
      return
    }

    setPending(true)
    try {
      const result = await createManualEntry({
        departmentId: effectiveDepartmentId,
        type,
        vendorName,
        invoiceNumber,
        date,
        amount: parsedAmount,
        budgetHeadId,
        remark,
      })
      if (!result.ok) {
        toastError(result.error, { title: 'Could not add the entry', context: 'new-entry-dialog' })
        return
      }
      toast.success(`Entry ${result.ubblNumber} added.`, {
        description: 'This is a temporary number — replace it with the real UBBL number on the entry once you have it.',
      })
      resetForm()
      setOpen(false)
      onCreated()
      router.refresh()
    } catch (err) {
      toastError(err instanceof Error ? err.message : null, {
        title: 'Could not add the entry',
        context: 'new-entry-dialog',
      })
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetForm()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">New entry</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an entry</DialogTitle>
          <DialogDescription>
            For bills typed in here rather than imported. It gets a temporary number starting with{' '}
            <span className="font-mono">M-</span> so it is easy to spot; replace that with the real UBBL number on
            the entry once the paperwork arrives.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-entry-department">Department</Label>
              {lockedDepartmentId === null ? (
                <SelectNative
                  id="new-entry-department"
                  value={departmentId === null ? '' : String(departmentId)}
                  onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Select a department…</option>
                  {selectableDepartments.map((d) => (
                    <option key={d.id} value={String(d.id)}>
                      {d.label}
                    </option>
                  ))}
                </SelectNative>
              ) : (
                <Input id="new-entry-department" value={lockedDepartmentName ?? 'Your department'} readOnly disabled />
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-entry-type">Type</Label>
              <SelectNative
                id="new-entry-type"
                value={type}
                onChange={(e) => setType(e.target.value as typeof type)}
              >
                {ENTRY_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </SelectNative>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-entry-vendor">Vendor / payee</Label>
            <Input
              id="new-entry-vendor"
              placeholder="Name exactly as it appears on the bill"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-entry-invoice">Bill number</Label>
              <Input
                id="new-entry-invoice"
                placeholder="Optional"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-entry-date">Bill date</Label>
              <Input id="new-entry-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-entry-amount">Amount (₹)</Label>
              <Input
                id="new-entry-amount"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-entry-budget-head">Budget head</Label>
            <SelectNative
              id="new-entry-budget-head"
              value={budgetHeadId === null ? '' : String(budgetHeadId)}
              onChange={(e) => setBudgetHeadId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Not set yet</option>
              {selectableBudgetHeads.map((b) => (
                <option key={b.id} value={String(b.id)}>
                  {b.label}
                </option>
              ))}
            </SelectNative>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-entry-remark">Remark</Label>
            <Textarea
              id="new-entry-remark"
              placeholder="Optional — anything the next person should know about this bill."
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? 'Adding…' : 'Add entry'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
