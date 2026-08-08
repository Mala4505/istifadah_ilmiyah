import { cn } from '@/lib/utils'

// Status-role colors, not the categorical chart palette (dataviz skill,
// "Status colors are reserved ... never reused for 'series N'"). Sub-3:1
// light-surface contrast pairs (amber) always ship with the text label next
// to them here, never color alone.
const SEVERITY_STYLES: Record<string, string> = {
  high: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  low: 'bg-secondary text-secondary-foreground',
}

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const key = severity && severity in SEVERITY_STYLES ? severity : 'low'
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
        SEVERITY_STYLES[key]
      )}
    >
      {severity ?? 'unknown'}
    </span>
  )
}

const AGE_BUCKET_STYLES: Record<string, string> = {
  '0-2': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  '3-7': 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  '8+': 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
}

export function AgeBucketBadge({ bucket }: { bucket: string | null | undefined }) {
  const key = bucket ?? '0-2'
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
        AGE_BUCKET_STYLES[key] ?? AGE_BUCKET_STYLES['0-2']
      )}
    >
      {key} days
    </span>
  )
}
