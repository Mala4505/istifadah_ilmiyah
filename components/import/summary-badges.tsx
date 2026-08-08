import { Badge } from '@/components/ui/badge'
import { actionDisplay } from '@/components/import/row-log-badge'

/** Row of "N inserted", "N updated", … badges built from ImportResult.summary. */
export function SummaryBadges({ summary }: { summary: Record<string, number> }) {
  const entries = Object.entries(summary).filter(([, count]) => count > 0)
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No rows processed.</p>
  }
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([action, count]) => {
        const { label, variant } = actionDisplay(action)
        return (
          <Badge key={action} variant={variant}>
            {count} {label.toLowerCase()}
          </Badge>
        )
      })}
    </div>
  )
}
