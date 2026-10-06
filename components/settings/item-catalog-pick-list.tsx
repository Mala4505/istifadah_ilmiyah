'use client'

import { useMemo, useState } from 'react'
import { Check } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface PickOption {
  id: number
  label: string
  /** Secondary line under the label (family, category…). */
  hint?: string | null
}

/**
 * Search box + scrollable option list for the item-catalog dialogs (move to
 * family, merge into item, assign a line). Same shape as the vendor merge
 * dialog's picker -- catalog labels are long ("CPVC brass-insert fitting ·
 * 0.75x0.5in"), so a full-width list reads better than a narrow combobox.
 */
export function PickList({
  options,
  value,
  onChange,
  placeholder,
  emptyText = 'Nothing matches.',
  limit = 50,
}: {
  options: PickOption[]
  value: number | null
  onChange: (id: number) => void
  placeholder: string
  emptyText?: string
  limit?: number
}) {
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = q
      ? options.filter(
          (o) => o.label.toLowerCase().includes(q) || (o.hint?.toLowerCase().includes(q) ?? false),
        )
      : options
    return matched.slice(0, limit)
  }, [options, query, limit])

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder={placeholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
        aria-label={placeholder}
      />
      <div className="max-h-72 overflow-y-auto rounded-md border border-border" role="listbox">
        {visible.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">{emptyText}</p>
        ) : (
          visible.map((option) => {
            const selected = option.id === value
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onChange(option.id)}
                className={cn(
                  'flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                  selected && 'bg-accent',
                )}
              >
                <Check
                  className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{option.label}</span>
                  {option.hint ? <span className="text-xs text-muted-foreground">{option.hint}</span> : null}
                </span>
              </button>
            )
          })
        )}
      </div>
      {options.length > limit && visible.length === limit ? (
        <p className="text-xs text-muted-foreground">Showing the first {limit} -- type to narrow the list.</p>
      ) : null}
    </div>
  )
}
