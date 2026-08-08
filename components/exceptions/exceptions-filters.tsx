'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EXCEPTION_TYPES, exceptionTypeLabel } from '@/components/exceptions/labels'

const STATUS_TABS = [
  { value: 'open', label: 'Open' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
  { value: 'all', label: 'All' },
] as const

export function ExceptionsFilters({
  status,
  type,
}: {
  status: string
  type: string
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
