'use client'

/**
 * Searchable single-select combobox: a Popover-trigger Button + cmdk's
 * Command list, composed the standard shadcn "Combobox" way (see
 * https://ui.shadcn.com/docs/components/combobox). Built for
 * review-status-line.tsx's Admin head / Zone pickers, whose plain Radix
 * <Select> only offered prefix type-ahead against "{number}. {name}" labels
 * (typing "3" jumped to option 3, typing "W" did nothing) -- this filters on
 * a caller-supplied searchValue as a substring match anywhere in the string,
 * so both the number and the name are searchable.
 *
 * Kept generic over `value`/`label`/`searchValue` rather than the specific
 * admin-head/zone shape so both call sites in review-status-line.tsx can
 * share one component; there was no second use case that justified more
 * abstraction than that.
 */

import * as React from 'react'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ComboboxOption {
  value: string
  label: string
  /** What typed search text is matched against (substring, case-insensitive). */
  searchValue: string
}

export function Combobox({
  id,
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches.',
  disabled,
  className,
}: {
  id?: string
  options: ComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((option) => option.value === value)

  // Distinguishes a mouse-driven focus (mousedown fires just before focus,
  // then the trigger's own click handler toggles `open`) from a
  // keyboard/programmatic one (Tab, or review-workspace.tsx's Z/H shortcuts
  // calling `document.getElementById(id)?.focus()` directly). Only the
  // latter should open the popover on focus alone -- otherwise a mouse click
  // would open it via this handler and then immediately close it again via
  // Radix's own click-to-toggle, since by the time the click fires `open`
  // already flipped true.
  const pointerFocusRef = React.useRef(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          onPointerDown={() => {
            pointerFocusRef.current = true
          }}
          onFocus={() => {
            if (!pointerFocusRef.current) {
              setOpen(true)
            }
            pointerFocusRef.current = false
          }}
          className={cn(
            'h-8 w-48 justify-between px-2 text-xs font-normal',
            !selected && 'text-muted-foreground',
            className
          )}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-0">
        <Command
          filter={(itemValue, search) => {
            const option = options.find((o) => o.value === itemValue)
            const haystack = (option?.searchValue ?? itemValue).toLowerCase()
            return haystack.includes(search.toLowerCase()) ? 1 : 0
          }}
        >
          <Command.Input
            placeholder={searchPlaceholder}
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <Command.List className="max-h-56 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-4 text-center text-xs text-muted-foreground">{emptyText}</Command.Empty>
            {options.map((option) => (
              <Command.Item
                key={option.value}
                value={option.value}
                onSelect={() => {
                  onValueChange(option.value)
                  setOpen(false)
                }}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', option.value === value ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                <span className="truncate">{option.label}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
