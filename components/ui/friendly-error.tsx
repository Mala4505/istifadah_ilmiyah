import { friendlyErrorMessage } from '@/lib/friendly-error'
import { cn } from '@/lib/utils'

/**
 * Plain-English summary up front, the raw error tucked behind a
 * <details> toggle rather than dropped — an admin chasing a real bug still
 * needs it, but it shouldn't be the first (or only) thing an operator sees.
 */
export function FriendlyError({
  message,
  className,
}: {
  message: string | null | undefined
  className?: string
}) {
  if (!message) return null
  const friendly = friendlyErrorMessage(message)

  return (
    <div className={cn('text-sm text-destructive', className)}>
      <p>{friendly}</p>
      {friendly !== message.trim() && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            Technical detail
          </summary>
          <p className="mt-1 text-xs text-muted-foreground">{message}</p>
        </details>
      )}
    </div>
  )
}
