import { cn } from '@/lib/utils'

/**
 * Plain determinate progress bar -- no @radix-ui/react-progress dependency,
 * since a single filled div covers every current use (chunked-upload
 * progress) and this codebase already prefers small hand-rolled primitives
 * over a new package for one component (see Skeleton, Badge).
 */
function Progress({
  value,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  /** 0-100. Clamped, so a caller's own rounding/edge-case math can't overflow the bar. */
  value: number
}) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      {...props}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
        style={{ width: clamped + '%' }}
      />
    </div>
  )
}

export { Progress }
