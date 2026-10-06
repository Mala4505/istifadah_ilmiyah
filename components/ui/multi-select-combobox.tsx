'use client'

/**
 * Searchable multi-select: the same Popover + cmdk composition as
 * combobox.tsx, but an explicit separate variant rather than a `multiple`
 * boolean on that one — selecting toggles an item and keeps the list open,
 * and the trigger summarises the selection instead of showing one label.
 * Built for the Entries Status / Department filters
 * (docs/hub-screen-certification.md §4.11).
 */

import * as React from 'react'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface MultiSelectOption {
  value: string
  label: string
}

export function MultiSelectCombobox({
  id,
  options,
  values,
  onToggle,
  onClear,
  placeholder = 'Any',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  className,
}: {
  id?: string
  options: MultiSelectOption[]
  values: readonly string[]
  onToggle: (value: string) => void
  onClear: () => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = new Set(values)
  const firstLabel = values.length > 0 ? options.find((o) => o.value === values[0])?.label : undefined
  const summary =
    values.length === 0
      ? placeholder
      : values.length === 1
        ? firstLabel ?? '1 selected'
        : `${firstLabel ?? values[0]} +${values.length - 1}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'h-9 w-full justify-between border-input bg-background px-3 text-sm font-normal shadow-sm',
            values.length === 0 && 'text-muted-foreground',
            className,
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <Command
          filter={(itemValue, search) => {
            const option = options.find((o) => o.value === itemValue)
            const haystack = (option?.label ?? itemValue).toLowerCase()
            return haystack.includes(search.toLowerCase()) ? 1 : 0
          }}
        >
          <Command.Input
            placeholder={searchPlaceholder}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</Command.Empty>
            {options.map((option) => {
              const isSelected = selected.has(option.value)
              return (
                <Command.Item
                  key={option.value}
                  value={option.value}
                  onSelect={() => onToggle(option.value)}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary',
                      isSelected ? 'bg-primary text-primary-foreground' : 'opacity-60',
                    )}
                    aria-hidden="true"
                  >
                    {isSelected ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="truncate">{option.label}</span>
                  {isSelected ? <span className="sr-only"> (selected)</span> : null}
                </Command.Item>
              )
            })}
          </Command.List>
          {values.length > 0 ? (
            <div className="border-t border-border p-1">
              <button
                type="button"
                onClick={onClear}
                className="w-full rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Clear selection ({values.length})
              </button>
            </div>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}
