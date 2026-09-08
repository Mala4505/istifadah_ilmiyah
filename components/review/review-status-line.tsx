'use client'

/**
 * Redesign plan §4: the single Verify -> Connect -> Classify status line.
 * Replaces three separate places (StageProgress's chip row, a standalone
 * MatchStrip card, and a standalone Classify bar at the page bottom) with one
 * card, one row, three segments -- each carrying its step's real control, not
 * just a status label. Supersedes the old stage-progress.tsx entirely.
 *
 * Redesign plan §4 (second pass): the three segments used to be bordered
 * flex-1 boxes side by side, each with its own "1 Verify" pill. Now it's one
 * horizontal stepper -- a numbered/check circle + label per step, connected
 * by a thin line that's the flex-growing element (not the controls, which
 * stay their natural/fixed width) so the row reads as one continuous line
 * spanning the full width instead of three boxes. `overflow-x-auto` is the
 * fallback on narrow viewports -- the row stays one line and scrolls instead
 * of wrapping into a stack, since a wrapped stepper stops reading as a
 * stepper.
 *
 * This component owns no state of its own -- every value and handler is
 * lifted from review-workspace.tsx (vendorAutocompleteOpen, the uncertain-
 * field stepper, adminHeadId/zoneId, MatchStrip's own props) so there is
 * exactly one source of truth for each, same as before this file existed.
 */

import { memo } from 'react'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Combobox } from '@/components/ui/combobox'
import { formatBinding, type Keymap } from '@/lib/shortcuts/config'
import { formatDateTime } from '@/lib/reports/format'
import type { VendorSearchResult } from '@/lib/actions/review'
import type { AttachedEntryView, MatchCandidate, UncertainField } from '@/lib/review/types'
import { MatchStrip } from './match-strip'
import { VendorAutocomplete } from './vendor-autocomplete'

// Matches review-workspace.tsx's own NONE sentinel exactly (both are plain
// string literals compared by value, not by shared identity) -- see that
// file's Stage 3 comment for why a string + sentinel instead of `number | null`.
const NONE = '__none__'

export type StageStatus = 'done' | 'current' | 'blocked'

function StepCircle({ index, status }: { index: number; status: StageStatus }) {
  const styles =
    status === 'done'
      ? 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-600 dark:bg-emerald-600'
      : status === 'current'
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-muted text-muted-foreground'

  return (
    <span
      className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none ${styles}`}
    >
      {status === 'done' ? <Check className="h-3 w-3" aria-hidden="true" /> : index}
    </span>
  )
}

// The stretching element between steps -- flex-1 so IT fills leftover width,
// not the step controls either side of it (plan §4's explicit ask).
function Connector() {
  return <div aria-hidden="true" className="h-px min-w-3 flex-1 bg-border" />
}

// Perf 5.2: memo-wrapped -- this whole row is pure presentation lifted from
// review-workspace.tsx's state, so it only needs to re-render when one of
// its own props actually changes (all now stable references/primitives from
// the caller).
function ReviewStatusLineImpl({
  // Verify segment
  verifyStatus,
  verifiedAt,
  vendorName,
  vendorId,
  linkedVendorName,
  vendorAutocompleteOpen,
  onVendorAutocompleteOpenChange,
  onVendorSelect,
  keymap,
  uncertainFields,
  uncertainStepIndex,
  onStepUncertainField,
  formDisabled,
  // Connect segment (forwarded straight through to MatchStrip)
  connectStatus,
  documentExtractionId,
  sourceDocumentId,
  attachedEntries,
  billTotal,
  entryDepartmentName,
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
  subDepartmentId,
  onSubDepartmentChange,
  subDepartmentOptions,
}: {
  verifyStatus: StageStatus
  verifiedAt: string | null
  vendorName: string
  vendorId: number | null
  linkedVendorName: string | null
  vendorAutocompleteOpen: boolean
  onVendorAutocompleteOpenChange: (open: boolean) => void
  onVendorSelect: (vendor: VendorSearchResult) => void
  keymap: Keymap
  uncertainFields: UncertainField[]
  uncertainStepIndex: number | null
  onStepUncertainField: (direction: 1 | -1) => void
  formDisabled: boolean

  connectStatus: StageStatus
  documentExtractionId: number
  sourceDocumentId: number
  attachedEntries: AttachedEntryView[]
  billTotal: number | null
  entryDepartmentName: string | null
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
  subDepartmentId: string
  onSubDepartmentChange: (value: string) => void
  subDepartmentOptions: { id: number; name: string }[]
}) {
  return (
    <div className="flex w-full items-center gap-2 overflow-x-auto rounded-md border border-border bg-background px-6 py-2 text-sm">
      {/* Verify */}
      <div className="flex shrink-0 items-center gap-2">
        <StepCircle index={1} status={verifyStatus} />
        <span
          className="text-xs font-medium text-muted-foreground"
          title={verifiedAt ? `Verified ${formatDateTime(verifiedAt)}` : undefined}
        >
          Verify
        </span>
        {/* The one linked-vendor control (plan §2.4). Was previously mirrored
            as a "Linked vendor" row in the extraction form's right pane --
            same popover state, same select handler -- which read as a
            duplicate of this step (user, 2026-09-07: "remove the right view
            one, step 1 is fine"). `searchSeed={vendorName}` still prefills
            the search with the OCR/edited vendor_name transcription. */}
        <div className="w-44 shrink-0" title={`Link vendor (${formatBinding(keymap.openVendorAutocomplete)})`}>
          <VendorAutocomplete
            value={linkedVendorName ?? ''}
            searchSeed={vendorName}
            selectedVendorId={vendorId}
            open={vendorAutocompleteOpen}
            onOpenChange={onVendorAutocompleteOpenChange}
            onSelect={onVendorSelect}
            disabled={formDisabled}
            fieldIndex={0}
          />
        </div>
        {uncertainFields.length > 0 ? (
          <span className="flex shrink-0 items-center gap-0.5 text-xs text-orange-700 dark:text-orange-400">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0 text-orange-700 hover:bg-orange-100 dark:text-orange-400 dark:hover:bg-orange-900"
              aria-label="Previous flagged field"
              onClick={() => onStepUncertainField(-1)}
            >
              &lsaquo;
            </Button>
            {uncertainStepIndex !== null ? uncertainStepIndex + 1 : '—'}/{uncertainFields.length}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-5 w-5 p-0 text-orange-700 hover:bg-orange-100 dark:text-orange-400 dark:hover:bg-orange-900"
              aria-label="Next flagged field"
              onClick={() => onStepUncertainField(1)}
            >
              &rsaquo;
            </Button>
          </span>
        ) : null}
      </div>

      <Connector />

      {/* Connect */}
      <div className="flex shrink-0 items-center gap-2">
        <StepCircle index={2} status={connectStatus} />
        <span className="text-xs font-medium text-muted-foreground">Connect</span>
        <MatchStrip
          bare
          documentExtractionId={documentExtractionId}
          sourceDocumentId={sourceDocumentId}
          attachedEntries={attachedEntries}
          billTotal={billTotal}
          entryDepartmentName={entryDepartmentName}
          matchCandidates={matchCandidates}
          onChanged={onMatchChanged}
        />
      </div>

      <Connector />

      {/* Classify -- only reachable once Connect is done (stage2Done); before
          that, a single line of placeholder text instead of two grayed-out
          selects (plan §4, "nothing renders that the reviewer can't act on
          yet"). */}
      <div className="flex shrink-0 items-end gap-2">
        <div className="flex items-center gap-2 self-center">
          <StepCircle index={3} status={classifyStatus} />
          <span className="text-xs font-medium text-muted-foreground">Classify</span>
        </div>
        {!stage2Done ? (
          <span className="self-center text-xs text-muted-foreground">unlocks once connected</span>
        ) : (
          <>
            {/* Redesign (Classify legibility): a caption above each field so
                a reviewer can tell them apart independent of whatever value
                (or "No X") happens to be showing in the trigger -- three
                unlabelled selects in a row were indistinguishable once
                filled in, since the trigger only ever renders the picked
                option's own label. */}
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium leading-none text-muted-foreground">Sub-department</span>
              <Combobox
                id="stage3-sub-department-select"
                value={subDepartmentId}
                onValueChange={onSubDepartmentChange}
                placeholder={`Sub-department (${formatBinding(keymap.focusSubDepartment)})`}
                searchPlaceholder="Search sub-departments…"
                className="w-36"
                options={[
                  { value: NONE, label: 'No sub-department', searchValue: 'not set' },
                  ...subDepartmentOptions.map((s) => ({
                    value: String(s.id),
                    label: s.name,
                    searchValue: s.name,
                  })),
                ]}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium leading-none text-muted-foreground">Admin head</span>
              <Combobox
                id="stage3-admin-head-select"
                value={adminHeadId}
                onValueChange={onAdminHeadChange}
                placeholder={`Admin head (${formatBinding(keymap.focusAdminHead)})`}
                searchPlaceholder="Search admin heads…"
                className="w-36"
                options={[
                  { value: NONE, label: 'No admin head', searchValue: 'not set' },
                  ...adminHeadOptions.map((h) => ({
                    value: String(h.id),
                    label: `${h.head_number}. ${h.name}`,
                    searchValue: `${h.head_number}. ${h.name}`,
                  })),
                ]}
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium leading-none text-muted-foreground">Zone</span>
              <Combobox
                id="stage3-zone-select"
                value={zoneId}
                onValueChange={onZoneChange}
                placeholder={`Zone (${formatBinding(keymap.focusZone)})`}
                searchPlaceholder="Search zones…"
                className="w-32"
                options={[
                  { value: NONE, label: 'No zone', searchValue: 'not set' },
                  ...zoneOptions.map((z) => ({
                    value: String(z.id),
                    label: `${z.zone_number}. ${z.name}`,
                    searchValue: `${z.zone_number}. ${z.name}`,
                  })),
                ]}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export const ReviewStatusLine = memo(ReviewStatusLineImpl)
