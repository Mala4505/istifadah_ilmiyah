'use client'

/**
 * Searchable multi-select popover for assigning a dept-role staff member to
 * one or more departments. Built on the same Popover + cmdk Command pattern
 * as ui/combobox.tsx, but stays open across selections (unlike that single-
 * select combobox, which closes on choice) and shows a compact name/count
 * summary in the trigger instead of embedding a full checkbox list inline —
 * the previous users-table.tsx implementation rendered every department as
 * an always-visible checkbox in a fixed-height box per row, which made the
 * roster unreadable once department count grew past a handful (imports add
 * departments with zero schema change, per MASTER-PLAN §3).
 */

import * as React from 'react'
import { Command } from 'cmdk'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface DepartmentPickerOption {
  id: number
  name: string
}

export function DepartmentPicker({
  id,
  options,
  selectedIds,
  onChange,
  disabled,
  className,
}: {
  id?: string
  options: DepartmentPickerOption[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  disabled?: boolean
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  const selectedNames = React.useMemo(() => {
    const byId = new Map(options.map((option) => [option.id, option.name]))
    return selectedIds.map((sid) => byId.get(sid)).filter((name): name is string => name !== undefined)
  }, [options, selectedIds])

  function toggle(departmentId: number) {
    onChange(
      selectedIds.includes(departmentId)
        ? selectedIds.filter((existingId) => existingId !== departmentId)
        : [...selectedIds, departmentId]
    )
  }

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
          title={selectedNames.length > 0 ? selectedNames.join(', ') : undefined}
          className={cn('h-8 w-[220px] justify-between px-2 text-xs font-normal', className)}
        >
          {selectedNames.length === 0 ? (
            <span className="text-muted-foreground">Select departments…</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1 overflow-hidden">
              <span className="truncate">{selectedNames.slice(0, 2).join(', ')}</span>
              {selectedNames.length > 2 && (
                <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                  +{selectedNames.length - 2}
                </Badge>
              )}
            </span>
          )}
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[240px] p-0">
        <Command
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0)}
        >
          <Command.Input
            placeholder="Search departments…"
            className="w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center justify-between border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
            <button type="button" className="hover:text-foreground" onClick={() => onChange(options.map((o) => o.id))}>
              Select all
            </button>
            <span>{selectedNames.length} selected</span>
            <button type="button" className="hover:text-foreground" onClick={() => onChange([])}>
              Clear
            </button>
          </div>
          <Command.List className="max-h-56 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-4 text-center text-xs text-muted-foreground">
              No departments match.
            </Command.Empty>
            {options.map((option) => (
              <Command.Item
                key={option.id}
                value={option.name}
                onSelect={() => toggle(option.id)}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', selectedIds.includes(option.id) ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                <span className="truncate">{option.name}</span>
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
