'use client'

/**
 * The comparison-basis half of the Reports period bar (reporting-blueprint.md
 * §6 fix #9 / §8 Phase One "period comparison in the shell"). Same
 * select-then-refresh shape as EventSwitcher (components/app-shell/event-
 * switcher.tsx): local state for immediate feedback, `useTransition` to call
 * the server action, `router.refresh()` on success so every server-rendered
 * tile/chart downstream re-reads the new `report_compare_basis` cookie via
 * `getCompareBasis()`.
 *
 * Deliberately does NOT import anything but the `CompareBasis` *type* from
 * lib/reports/compare-basis.ts -- that module imports `next/headers` at
 * module scope (it also holds the server-side `getCompareBasis()` cookie
 * reader), so a runtime import of any of its value exports (e.g.
 * `COMPARE_BASIS_LABELS`) would drag `next/headers` into this client bundle
 * and fail the build. `options` (value/label pairs) is passed in as a prop
 * instead, computed once by the server-component parent
 * (reports-period-bar.tsx), which can import that module freely. A type-only
 * import is erased at compile time and carries no such risk.
 */
import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { setCompareBasis } from '@/lib/actions/reports'
import { toastError } from '@/components/ui/error-toast'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CompareBasis } from '@/lib/reports/compare-basis'

export function CompareBasisSelect({
  value: initialValue,
  options,
}: {
  value: CompareBasis
  options: { value: CompareBasis; label: string }[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [value, setValue] = useState<CompareBasis>(initialValue)

  function handleChange(next: string) {
    const basis = next as CompareBasis
    if (basis === value) return
    setValue(basis)
    startTransition(async () => {
      const result = await setCompareBasis(basis)
      if (!result.ok) {
        toastError(result.error, { context: 'compare-basis-select' })
        setValue(initialValue)
        return
      }
      router.refresh()
    })
  }

  return (
    <Select value={value} onValueChange={handleChange} disabled={isPending}>
      <SelectTrigger className="h-9 w-44" aria-label="Comparison period">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
