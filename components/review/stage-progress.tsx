'use client'

/**
 * Three-stage review flow, shown as a lightweight legibility aid, NOT a
 * wizard (MASTER-PLAN §8): 1 Verify (the form) -> 2 Connect (the match
 * strip) -> 3 Classify (admin head + zone). Stage 3 is non-blocking by
 * explicit plan decision (§8) -- "blocked" here only means "not reachable
 * yet because stage 2 isn't done", never "Save is disabled".
 */

export type StageStatus = 'done' | 'current' | 'blocked'

function StageChip({ index, label, status }: { index: number; label: string; status: StageStatus }) {
  const styles =
    status === 'done'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
      : status === 'current'
        ? 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200'
        : 'border-border bg-muted text-muted-foreground'

  return (
    <span className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${styles}`}>
      <span className="font-semibold">{index}</span>
      {label}
      {status === 'done' ? ' ✓' : null}
    </span>
  )
}

export function StageProgress({
  verify,
  connect,
  classify,
}: {
  verify: StageStatus
  connect: StageStatus
  classify: StageStatus
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <StageChip index={1} label="Verify" status={verify} />
      <span aria-hidden className="text-muted-foreground">
        &rarr;
      </span>
      <StageChip index={2} label="Connect" status={connect} />
      <span aria-hidden className="text-muted-foreground">
        &rarr;
      </span>
      <StageChip index={3} label="Classify" status={classify} />
    </div>
  )
}
