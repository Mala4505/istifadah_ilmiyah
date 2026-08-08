import { Card, CardContent } from '@/components/ui/card'

/**
 * Task point 6: a minimal placeholder for Day 4. The real document
 * upload/viewer is Phase 1B (§11.2) and explicitly out of scope here.
 */
export function DocumentsNote({ count }: { count: number }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-2 py-4">
        <p className="text-sm">
          Documents: <span className="font-medium">{count}</span> attached
        </p>
        <p className="text-xs text-muted-foreground">Full document viewer ships in Phase 1B.</p>
      </CardContent>
    </Card>
  )
}
