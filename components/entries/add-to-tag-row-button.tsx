import { Tag } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The per-row "Add to tag" icon button (super-admin only -- the caller decides whether to
 * render it). Shared by the single-row and the grouped-by-vendor entries tables so both carry
 * the same label and tooltip. The caller's cell stops click propagation so the row's own
 * "open the entry" click does not fire.
 */
export function AddToTagRowButton({
  ubblNumber,
  onClick,
}: {
  ubblNumber: string
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7"
      title="Add to tag"
      aria-label={`Add entry ${ubblNumber} to a tag`}
      onClick={onClick}
    >
      <Tag className="h-3.5 w-3.5" />
    </Button>
  )
}
