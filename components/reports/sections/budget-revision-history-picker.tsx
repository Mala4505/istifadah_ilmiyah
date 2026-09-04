'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { formatINRCompact } from '@/lib/reports/format'

/**
 * A-02 budget-head picker (reporting-blueprint.md §8 Phase Six / A-02). A
 * search box over a pre-supplied candidate list of budget heads that have
 * more than one dated allocation snapshot; choosing one writes
 * `?revision_head_id=<id>` and the Server Component section re-renders that
 * head's revision waterfall. Same shape as E-05's
 * rupee-provenance-picker.tsx: no data fetching here, this only touches the
 * URL (next/navigation), so it stays a leaf client component with no import
 * of any server module.
 */

export type BudgetRevisionHistoryCandidate = {
  id: number
  /** Pre-formatted on the server: "head label · department". */
  label: string
  revisionCount: number
  upwardTotal: number
}

const HEAD_PARAM = 'revision_head_id'
const MAX_VISIBLE = 30

export function BudgetRevisionHistoryPicker({
  candidates,
  selectedId,
}: {
  candidates: BudgetRevisionHistoryCandidate[]
  selectedId: number | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = q
      ? candidates.filter((c) => c.label.toLowerCase().includes(q) || String(c.id).includes(q))
      : candidates
    return matches.slice(0, MAX_VISIBLE)
  }, [candidates, query])

  function buildHref(id: number | null): string {
    const next = new URLSearchParams(searchParams.toString())
    if (id === null) next.delete(HEAD_PARAM)
    else next.set(HEAD_PARAM, String(id))
    const qs = next.toString()
    return qs ? `${pathname}?${qs}#budget-revision-history` : `${pathname}#budget-revision-history`
  }

  function select(id: number | null) {
    startTransition(() => {
      router.replace(buildHref(id), { scroll: false })
    })
  }

  if (candidates.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Pick a budget head to chart
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by head or department…"
          className="rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground"
        />
      </label>

      {selectedId !== null && (
        <button
          type="button"
          onClick={() => select(null)}
          disabled={isPending}
          className="self-start text-xs text-primary underline-offset-2 hover:underline disabled:opacity-50"
        >
          Clear selection
        </button>
      )}

      <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-md border border-border p-1">
        {filtered.length === 0 ? (
          <li className="px-2 py-2 text-xs text-muted-foreground">No head matches that search.</li>
        ) : (
          filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => select(c.id)}
                disabled={isPending}
                aria-current={c.id === selectedId ? 'true' : undefined}
                className={
                  'flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 ' +
                  (c.id === selectedId ? 'bg-accent text-accent-foreground' : '')
                }
              >
                <span className="min-w-0 truncate">{c.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {c.revisionCount} snapshots
                  {c.upwardTotal > 0 ? ` · +${formatINRCompact(c.upwardTotal)}` : ''}
                </span>
              </button>
            </li>
          ))
        )}
      </ul>
      {candidates.length > MAX_VISIBLE && query.trim() === '' && (
        <p className="text-xs text-muted-foreground">
          Showing the first {MAX_VISIBLE} heads — search to narrow to any other.
        </p>
      )}
    </div>
  )
}
