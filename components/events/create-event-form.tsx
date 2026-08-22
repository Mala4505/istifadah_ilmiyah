'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { toastError } from '@/components/ui/error-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { createEvent } from '@/lib/actions/events'

export interface MasterOption {
  id: number
  label: string
}

export interface EventMembershipSelection {
  departmentIds: number[]
  adminHeadIds: number[]
  zoneIds: number[]
  budgetHeadIds: number[]
}

/** One checklist column (doc §1.5: "a carry-forward step with every
 *  department, admin head and zone from the previous event pre-ticked.
 *  Untick what is gone, add what is new."). Budget heads get the same
 *  treatment here even though the doc's §1.5 prose only names the other
 *  three -- §1.1's later refinement adds event_budget_head as a fourth
 *  membership table with the same shape. */
function ChecklistColumn({
  title,
  options,
  selected,
  onToggle,
}: {
  title: string
  options: MasterOption[]
  selected: Set<number>
  onToggle: (id: number) => void
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">{title}</h4>
        <span className="text-xs text-muted-foreground">
          {selected.size}/{options.length}
        </span>
      </div>
      <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border border-border p-2">
        {options.length === 0 && <p className="text-xs text-muted-foreground">None available.</p>}
        {options.map((option) => (
          <label key={option.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-secondary/60">
            <Checkbox checked={selected.has(option.id)} onCheckedChange={() => onToggle(option.id)} />
            <span className="min-w-0 truncate">{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export function CreateEventForm({
  departments,
  adminHeads,
  zones,
  budgetHeads,
  initialSelection,
}: {
  departments: MasterOption[]
  adminHeads: MasterOption[]
  zones: MasterOption[]
  budgetHeads: MasterOption[]
  initialSelection: EventMembershipSelection
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [name, setName] = useState('')
  const [hijriYear, setHijriYear] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')

  const [departmentIds, setDepartmentIds] = useState(() => new Set(initialSelection.departmentIds))
  const [adminHeadIds, setAdminHeadIds] = useState(() => new Set(initialSelection.adminHeadIds))
  const [zoneIds, setZoneIds] = useState(() => new Set(initialSelection.zoneIds))
  const [budgetHeadIds, setBudgetHeadIds] = useState(() => new Set(initialSelection.budgetHeadIds))

  function toggle(set: Set<number>, setter: (next: Set<number>) => void, id: number) {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setter(next)
  }

  const canSubmit = useMemo(() => name.trim().length > 0 && hijriYear.trim().length > 0, [name, hijriYear])

  function handleSubmit() {
    startTransition(async () => {
      const result = await createEvent({
        name: name.trim(),
        hijriYear: hijriYear.trim(),
        startsOn: startsOn || null,
        endsOn: endsOn || null,
        departmentIds: Array.from(departmentIds),
        adminHeadIds: Array.from(adminHeadIds),
        zoneIds: Array.from(zoneIds),
        budgetHeadIds: Array.from(budgetHeadIds),
      })
      if (result.ok) {
        toast.success(`Event "${name.trim()}" created.`)
        setName('')
        setHijriYear('')
        setStartsOn('')
        setEndsOn('')
        router.refresh()
      } else {
        toastError(result.error, { context: 'create-event-form', title: 'Could not create the event' })
      }
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="event-name">Name</Label>
          <Input
            id="event-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Istifadah Ilmiyah 1449 H"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="event-hijri-year">Hijri year</Label>
          <Input id="event-hijri-year" value={hijriYear} onChange={(e) => setHijriYear(e.target.value)} placeholder="1449" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="event-starts-on">Starts on</Label>
          <Input id="event-starts-on" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="event-ends-on">Ends on</Label>
          <Input id="event-ends-on" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Carried forward from the currently-selected event. Untick what no longer applies, and use the master
          data screens to add anything genuinely new before it can be ticked here.
        </p>
        <div className="flex flex-col gap-4 md:flex-row">
          <ChecklistColumn
            title="Departments"
            options={departments}
            selected={departmentIds}
            onToggle={(id) => toggle(departmentIds, setDepartmentIds, id)}
          />
          <ChecklistColumn
            title="Admin heads"
            options={adminHeads}
            selected={adminHeadIds}
            onToggle={(id) => toggle(adminHeadIds, setAdminHeadIds, id)}
          />
          <ChecklistColumn
            title="Zones"
            options={zones}
            selected={zoneIds}
            onToggle={(id) => toggle(zoneIds, setZoneIds, id)}
          />
          <ChecklistColumn
            title="Budget heads"
            options={budgetHeads}
            selected={budgetHeadIds}
            onToggle={(id) => toggle(budgetHeadIds, setBudgetHeadIds, id)}
          />
        </div>
      </div>

      <div>
        <Button type="button" onClick={handleSubmit} disabled={!canSubmit || isPending}>
          {isPending ? 'Creating…' : 'Create event'}
        </Button>
      </div>
    </div>
  )
}
