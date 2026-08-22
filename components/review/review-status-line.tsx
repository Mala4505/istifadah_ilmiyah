'use client'

/**
 * Redesign plan §4: the single Verify -> Connect -> Classify status line.
 * Replaces three separate places (StageProgress's chip row, a standalone
 * MatchStrip card, and a standalone Classify bar at the page bottom) with one
 * card, one row, three segments -- each carrying its step's real control, not
 * just a status label. Supersedes the old stage-progress.tsx entirely (its
 * StageChip styling lives on here as SegmentLabel).
 *
 * This component owns no state of its own -- every value and handler is
 * lifted from review-workspace.tsx (vendorAutocompleteOpen, the uncertain-
 * field stepper, adminHeadId/zoneId, MatchStrip's own props) so there is
 * exactly one source of truth for each, same as before this file existed.
 */

import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { Label } from '@/components/ui/label'
import type { MatchCandidate, UncertainField } from '@/lib/review/types'
import { MatchStrip } from './match-strip'

// Matches review-workspace.tsx's own NONE sentinel exactly (both are plain
// string literals compared by value, not by shared identity) -- see that
// file's Stage 3 comment for why a string + sentinel instead of `number | null`.
const NONE = '__none__'

export type StageStatus = 'done' | 'current' | 'blocked'

function SegmentLabel({ index, label, status }: { index: number; label: string; status: StageStatus }) {
  const styles =
    status === 'done'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
      : status === 'current'
        ? 'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200'
        : 'border-border bg-muted text-muted-foreground'

  return (
    <span className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${styles}`}>
      <span className="font-semibold">{index}</span>
      {label}
      {status === 'done' ? ' ✓' : null}
    </span>
  )
}

export function ReviewStatusLine({
  // Verify segment
  verifyStatus,
  vendorName,
  vendorId,
  onOpenVendorPicker,
  uncertainFields,
  uncertainStepIndex,
  onStepUncertainField,
  formDisabled,
  // Connect segment (forwarded straight through to MatchStrip)
  connectStatus,
  documentExtractionId,
  sourceDocumentId,
  entryId,
  entryUbblNumber,
  entryVendorDisplayName,
  entryAmount,
  liveTotalAmount,
  matchCandidates,
  onMatchChanged,
  // Classify segment
  classifyStatus,
  stage2Done,
  adminHeadId,
  zoneId,
  onAdminHeadChange,
  onZoneChange,
  adminHeadOptions,
  zoneOptions,
}: {
  verifyStatus: StageStatus
  vendorName: string
  vendorId: number | null
  onOpenVendorPicker: () => void
  uncertainFields: UncertainField[]
  uncertainStepIndex: number | null
  onStepUncertainField: (direction: 1 | -1) => void
  formDisabled: boolean

  connectStatus: StageStatus
  documentExtractionId: number
  sourceDocumentId: number
  entryId: number | null
  entryUbblNumber: string | null
  entryVendorDisplayName: string | null
  entryAmount: number | null
  liveTotalAmount: number | null
  matchCandidates: MatchCandidate[]
  onMatchChanged: () => void

  classifyStatus: StageStatus
  stage2Done: boolean
  adminHeadId: string
  zoneId: string
  onAdminHeadChange: (value: string) => void
  onZoneChange: (value: string) => void
  adminHeadOptions: { id: number; head_number: number; name: string }[]
  zoneOptions: { id: number; zone_number: number; name: string }[]
}) {
  return (
    <div className="flex flex-col divide-y divide-border rounded-md border border-border bg-background text-sm lg:flex-row lg:divide-x lg:divide-y-0">
      {/* Verify */}
      <div className="flex flex-1 flex-wrap items-center gap-2 px-2 py-1.5">
        <SegmentLabel index={1} label="Verify" status={verifyStatus} />
        <span className="truncate font-medium">{vendorName || 'Vendor not set'}</span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
            vendorId !== null
              ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
              : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
          }`}
        >
          {vendorId !== null ? 'Linked vendor' : 'New / unconfirmed vendor'}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={onOpenVendorPicker} disabled={formDisabled}>
          Change vendor (/)
        </Button>
        {uncertainFields.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-orange-900 hover:bg-orange-100 dark:text-orange-200 dark:hover:bg-orange-900"
              aria-label="Previous flagged field"
              onClick={() => onStepUncertainField(-1)}
            >
              &lsaquo;
            </Button>
            {uncertainStepIndex !== null ? uncertainStepIndex + 1 : '—'} of {uncertainFields.length} to check
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-orange-900 hover:bg-orange-100 dark:text-orange-200 dark:hover:bg-orange-900"
              aria-label="Next flagged field"
              onClick={() => onStepUncertainField(1)}
            >
              &rsaquo;
            </Button>
          </span>
        ) : null}
      </div>

      {/* Connect */}
      <div className="flex flex-1 flex-wrap items-center gap-2 px-2 py-1.5">
        <SegmentLabel index={2} label="Connect" status={connectStatus} />
        <div className="min-w-0 flex-1">
          <MatchStrip
            bare
            documentExtractionId={documentExtractionId}
            sourceDocumentId={sourceDocumentId}
            entryId={entryId}
            entryUbblNumber={entryUbblNumber}
            entryVendorDisplayName={entryVendorDisplayName}
            entryAmount={entryAmount}
            liveTotalAmount={liveTotalAmount}
            matchCandidates={matchCandidates}
            onChanged={onMatchChanged}
          />
        </div>
      </div>

      {/* Classify -- only reachable once Connect is done (stage2Done); before
          that, a single line of placeholder text instead of two grayed-out
          selects (plan §4, "nothing renders that the reviewer can't act on
          yet"). */}
      <div className="flex flex-1 flex-wrap items-center gap-2 px-2 py-1.5">
        <SegmentLabel index={3} label="Classify" status={classifyStatus} />
        {!stage2Done ? (
          <span className="text-xs text-muted-foreground">unlocks once this bill is connected, above</span>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stage3-admin-head-select" className="text-xs">
                Admin head (H)
              </Label>
              <Combobox
                id="stage3-admin-head-select"
                value={adminHeadId}
                onValueChange={onAdminHeadChange}
                placeholder="Not set"
                searchPlaceholder="Search admin heads…"
                options={[
                  { value: NONE, label: 'Not set', searchValue: 'not set' },
                  ...adminHeadOptions.map((h) => ({
                    value: String(h.id),
                    label: `${h.head_number}. ${h.name}`,
                    searchValue: `${h.head_number}. ${h.name}`,
                  })),
                ]}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="stage3-zone-select" className="text-xs">
                Zone (Z)
              </Label>
              <Combobox
                id="stage3-zone-select"
                value={zoneId}
                onValueChange={onZoneChange}
                placeholder="Not set"
                searchPlaceholder="Search zones…"
                options={[
                  { value: NONE, label: 'Not set', searchValue: 'not set' },
                  ...zoneOptions.map((z) => ({
                    value: String(z.id),
                    label: `${z.zone_number}. ${z.name}`,
                    searchValue: `${z.zone_number}. ${z.name}`,
                  })),
                ]}
              />
            </div>
            <span className="text-xs text-muted-foreground">Saved with the next Save (Ctrl/Cmd+Enter)</span>
          </>
        )}
      </div>
    </div>
  )
}
