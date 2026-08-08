import * as React from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A plain <select> styled to match the design system, for simple filter
 * dropdowns where Radix Select's popover behavior isn't needed (e.g. inside
 * a filter bar with many side-by-side controls). Keeps the entries filter
 * bar lightweight — Radix `select.tsx` is still used where richer content
 * (icons, dividers) is needed.
 */
export type SelectNativeProps = React.SelectHTMLAttributes<HTMLSelectElement>

const SelectNative = React.forwardRef<HTMLSelectElement, SelectNativeProps>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'flex h-9 w-full appearance-none rounded-md border border-input bg-background px-3 py-1 pr-8 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
    </div>
  )
)
SelectNative.displayName = 'SelectNative'

export { SelectNative }
