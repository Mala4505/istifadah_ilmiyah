'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  EXCEPTION_TYPES,
  exceptionTypeLabel,
  SEVERITY_GROUP_LABELS,
  SEVERITY_VALUES,
} from '@/components/exceptions/labels'

const STATUS_TABS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
] as const

export function ExceptionsFilters({
  status,
  type,
  severity,
}: {
  status: string
  type: string
  severity: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function updateParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'all' || value === '') {
      params.delete(key)
    } else {
      params.set(key, value)
    }
    // Any filter change invalidates the current page position.
    params.delete('page')
    const query = params.toString()
    router.push(query ? `${pathname}?${query}` : pathname)
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Tabs value={status} onValueChange={(v) => updateParam('status', v)}>
        <TabsList>
          {STATUS_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Select value={severity} onValueChange={(v) => updateParam('severity', v)}>
        <SelectTrigger className="w-44">
          <SelectValue placeholder="All severities" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All severities</SelectItem>
          {SEVERITY_VALUES.map((s) => (
            <SelectItem key={s} value={s}>
              {SEVERITY_GROUP_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={type} onValueChange={(v) => updateParam('type', v)}>
        <SelectTrigger className="w-64">
          <SelectValue placeholder="All exception types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All exception types</SelectItem>
          {EXCEPTION_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {exceptionTypeLabel(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
