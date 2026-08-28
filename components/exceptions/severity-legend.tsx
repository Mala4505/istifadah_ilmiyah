import { Badge } from '@/components/ui/badge'
import { severityBadgeVariant, severityGroupLabel } from '@/components/exceptions/labels'

// Item 2.5 (hub-screen-certification.md Wave 2): severity is the queue's
// primary sort/group key, but the badge colours were never explained. This
// quiet inline legend spells out the three-colour scale; each badge also
// carries the full "<x> severity" phrase as an accessible label so a screen
// reader announces more than the bare word.
const LEGEND_ITEMS: { severity: string; label: string }[] = [
  { severity: 'high', label: 'High' },
  { severity: 'medium', label: 'Medium' },
  { severity: 'low', label: 'Low' },
]

export function SeverityLegend() {
  return (
    <div
      aria-label="Severity legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
    >
      {LEGEND_ITEMS.map(({ severity, label }) => (
        <span key={severity} className="inline-flex items-center gap-1.5">
          <Badge variant={severityBadgeVariant(severity)} aria-label={severityGroupLabel(severity)}>
            {label}
          </Badge>
        </span>
      ))}
    </div>
  )
}
