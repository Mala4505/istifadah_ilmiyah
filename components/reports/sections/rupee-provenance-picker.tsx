'use client'

import { useMemo, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { formatINR } from '@/lib/reports/format'

/**
 * E-05 entry picker (reporting-blueprint.md §3 E-05 / §4 -- "pick any rupee
 * and follow it live"). A search box over a pre-supplied candidate list;
 * choosing one writes `?trace_entry_id=<id>` and the Server Component section
 * re-renders the whole provenance chain from that id. No data fetching here --
 * the section hands down a minimal plain-data list, and this only touches the
 * URL (next/navigation), so it stays a leaf client component with no import
 * of any server module.
 */

export type RupeeProvenancePickerCandidate = {
  id: number
  /** Pre-formatted on the server: "UBBL · vendor · date". */
  label: string
  amount: number | null
}

const TRACE_PARAM = 'trace_entry_id'
const MAX_VISIBLE = 30

export function RupeeProvenancePicker({
  candidates,
  selectedId,
}: {
  candidates: RupeeProvenancePickerCandidate[]
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
    if (id === null) next.delete(TRACE_PARAM)
    else next.set(TRACE_PARAM, String(id))
    const qs = next.toString()
    return qs ? `${pathname}?${qs}#rupee-provenance` : `${pathname}#rupee-provenance`
  }

  function select(id: number | null) {
    startTransition(() => {
      router.replace(buildHref(id), { scroll: false })
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Pick a rupee to trace
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by UBBL, vendor or entry id…"
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
          <li className="px-2 py-2 text-xs text-muted-foreground">No entry matches that search.</li>
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
                <span className="shrink-0 tabular-nums text-muted-foreground">{formatINR(c.amount)}</span>
              </button>
            </li>
          ))
        )}
      </ul>
      {candidates.length > MAX_VISIBLE && query.trim() === '' && (
        <p className="text-xs text-muted-foreground">
          Showing the {MAX_VISIBLE} largest entries — search to narrow to any other.
        </p>
      )}
    </div>
  )
}
