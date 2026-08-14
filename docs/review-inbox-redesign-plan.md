# Review & Documents Inbox Redesign — Final Plan

**Status:** Implemented and verified 2026-08-14. `npm run typecheck` clean, `npm run test` 245/245 passing.

This is the final record of the seven-item improvement pass: the original plan, what actually got built (including deviations found during implementation), the fixes made during verification, and the further-simplification ideas raised alongside the [redesign artifact](https://claude.ai/code/artifact/9c050e9e-9d4f-4169-8315-63ee2443a06c). It supersedes the working plan doc it was built from.

---

## Context

Staff upload vendor invoices, Claude extracts structured fields, and reviewers reconcile them against ledger entries on `/review`. After a period of active development, real day-to-day use surfaced seven friction points spanning the extraction schema, a real "PDFs don't show up" bug, and UX gaps on the upload/review pages. Two decisions were confirmed with the user before work started:

- **Item 1** ("email ID of the invoice") means a **vendor email** field on the extraction schema/review form — the same way vendor phone/address already work, not a new email-ingestion channel.
- **Item 2**'s exclusion value (the community's own GSTIN) lives in a new env var, `COMMUNITY_GSTIN`. Shipped with a placeholder in `.env.example`; the real value has since been set.

---

## Item 3 diagnosis (why this changed the priority of everything else)

Newly-uploaded PDFs never showed up for review while older ones did. Root cause: `/review`'s queue (`v_review_queue`) only lists documents with a `document_extraction` row, which is only written by the `extract_document` job handler — which only runs when something is actively *draining* `public.job_queue`. There was no `vercel.json` and nothing scheduled to hit `/api/jobs/tick`, so unless `npm run worker` happened to be running, every upload sat at `upload_status = 'uploaded'` forever.

This can't be fixed from inside the codebase alone — it's an operational fact about what's running. What the plan shipped instead (folded into items 3+5):
1. Make the real state (uploaded/stuck vs. processing vs. processed/failed, and how long it's been stuck) visible in the Documents inbox.
2. A manual **"Extract now"** action that bypasses the job queue entirely.
3. **Still open with the user:** whether `npm run worker` needs to run persistently (or via Task Scheduler) — a deployment decision, not a code change.

---

## Items 1 + 2 — Vendor email, and excluding the community's own GSTIN

**Built as planned.** Files touched:

- `lib/extraction-schema.ts` — `vendor_email` added to the Zod schema, JSON tool schema, `required[]`, and `EXTRACTION_TOOL_DESCRIPTION`.
- `lib/env.server.ts` / `.env.example` — `COMMUNITY_GSTIN` added to `serverSchema` and `readServerEnv`, with an explanatory placeholder (now set to the real value).
- `lib/claude-client.ts` — `SYSTEM_PROMPT` became `buildSystemPrompt(communityGstin)`, called with `serverEnv.COMMUNITY_GSTIN || null` inside `extractDocument`; when set, instructs the model to extract the vendor/seller's GSTIN specifically and never return the community's own GSTIN as `vendor_gstin`.
- `lib/analytics/gstin.ts` — new `isSameGstin(a, b)` helper, the deterministic backstop behind the prompt-side instruction.
- `lib/jobs/handlers/extract.ts` — nulls `vendor_gstin_ocr` and raises a new low-severity `vendor_gstin_is_own_org` exception when `isSameGstin` matches; writes `vendor_email_ocr`.
- `supabase/migrations/20260814000010_document_extraction_vendor_email.sql` — adds `vendor_email_ocr`/`vendor_email_verified` columns; extends the `reconciliation_exception_exception_type_check` constraint (see **Fixes made during verification** below — this migration also repairs an unrelated pre-existing constraint bug).
- `supabase/migrations/20260814000011_verify_document_extraction_vendor_email.sql` — `private.verify_document_extraction` updated to also write `vendor_email_verified`, mirroring `vendor_phone_verified`.
- `lib/actions/review.ts`, `lib/review/types.ts` — `vendor_email` / `vendorEmail` threaded through.
- `app/(app)/review/page.tsx`, `components/review/extraction-form.tsx`, `components/review/review-workspace.tsx` — select string, header mapping, and a new "Email" form field next to "Phone", with `vendorEmail` threaded through `buildHeaderState`/`buildSavePayload`.

**Deviation found during implementation:** `test/unit/extraction-schema.test.ts`'s fixture needed `vendor_email: ''` added to `baseInput` once the field became required on the wire — not in the original file list, but necessary to keep the suite green (245/245 pass now).

---

## Items 3 + 5 — Real extraction status + progress in the Documents inbox

**Design:** staged progress (Uploaded → Queued → Extracting → Done/Failed), not a fake percentage — there's no partial progress obtainable from one non-streaming Claude tool-use call, so stages are both accurate and answer "how much is left."

- `components/documents/document-card.tsx` — the single status `Badge` replaced by an exported `DocumentStageTracker` component (reused at two sizes, see below), plus an elapsed-time line ("queued 6m ago"). New "Extract now" button (shown for `uploaded`/`failed`) calling the new server action.
- `components/documents/format.ts` — new `formatElapsed()` relative-time helper.
- `lib/actions/documents.ts` — new `manualExtractNow(documentId)`, role-checked the same way as `attachDocumentToEntry`, calling `extractAndPersist({ sourceDocumentId, runReason: 'manual_reescalation' })` directly — the same function the job handler and `/api/documents/reescalate` both call. Bypasses `job_queue` entirely.
- `components/documents/document-inbox.tsx` — polling `useEffect`: while any document is `uploaded`/`processing`, `router.refresh()` every ~4s; stops once none are.

**Factoring note:** the `uploadStatus` → stage mapping, elapsed-label builder, and stage icon all live once in `document-card.tsx` as `DocumentStageTracker`, with a `size: 'default' | 'sm'` prop — the card uses the full version, the table (item 4) uses the compact one. No duplicated status logic between the two screens.

---

## Item 4 — Documents table with pagination

- New `components/documents/document-table.tsx` — plain table on `components/ui/table.tsx` (no new dependency; `@tanstack/react-table` was in `package.json` but unused anywhere in the repo, and stayed that way). Columns: checkbox · filename (+pages) · vendor/invoice#/total · compact stage tracker · uploaded date · "Review" action. Client-side pagination, page size 20, `useState`-based.
- The "Review" action opens the existing `DocumentCard` content inside `components/ui/dialog.tsx`, mounted only for the currently-open row rather than every row rendering its full detail at once.
- `components/documents/document-inbox.tsx` — `documents.map(<DocumentCard/>)` replaced with `<DocumentTable/>`; the bulk-attach bar above it is unchanged.

---

## Item 6 — Collapsible sidebar, auto-collapsed on `/review`

`components/app-shell/nav-rail.tsx` only.

- `collapsed` state, initialized from and persisted to `localStorage['nav-rail-collapsed']` on manual toggle.
- A `reviewOverrideRef` (a ref, not state — it must survive re-renders without itself triggering one, and is never read during render) tracks "user manually re-expanded during this visit to `/review`."
- A `pathname`-keyed effect: entering `/review` force-collapses unless the ref is set; leaving `/review` clears the ref and restores the `localStorage` value.
- Collapsed width `w-14`, icon-only: labels go `sr-only` (not removed from the DOM) with `Tooltip` on hover; the same treatment extends to the footer (avatar, sign-out, Ctrl-K hint, theme toggle).

**Bug caught and fixed during implementation** (not shipped): the first draft computed the override flag with an inverted ternary; corrected before final typecheck.

**Undocumented in the original plan, found during verification:** `components/app-shell/command-palette.tsx` (111-line diff) was also built in this pass. It wires up real Cmd/Ctrl-K search — `Command.Dialog` from `cmdk`, debounced query against `searchEntriesForAttach` (`lib/actions/documents.ts`, the same RLS-scoped UBBL/Main/vendor/invoice search already used for document-attach), results list, `router.push` to `/entries/{id}`. It replaces a prior stub that rendered "Command palette search is not wired up yet." This should have been listed as its own item alongside item 6 rather than surfacing only as an unexplained diff. The Ideas section below has been corrected to reflect that this base palette now exists — see the "queue-position" idea.

**Fixed during verification:** the collapsed footer's Ctrl-K hint (`nav-rail.tsx`) went `sr-only` with no `Tooltip` replacement, unlike every other collapsed footer element (avatar, sign-out). Fixed to match: the `Ctrl K` kbd stays visible (acting as the icon-equivalent) and is wrapped in a `Tooltip` reading "Ctrl K — jump to entry" when collapsed.

---

## Item 7 — Review page UX

- **7a** — `app/(app)/review/loading.tsx` (new): Next.js's automatic loading convention, a two-pane skeleton matching `ReviewWorkspace`'s grid.
- **7b** — `components/review/pdf-viewer.tsx`: the plain "Loading document…" text replaced with a `Skeleton` at an A4-ish aspect ratio (`1 / 1.414`).
- **7c** — `components/review/review-workspace.tsx`: "Document {n} of {total}" added to the toolbar row next to Prev/Next, using the `queue`/`currentIndex` props the component already received but never rendered. The PageUp/PageDown → document-navigation mapping was deliberately left unchanged (it's intentional, documented in-code) — this only makes the boundary visible, it doesn't remap keys. Note: `app/(app)/review/page.tsx`'s `PageHeader` already showed a position elsewhere on the page; this adds a second copy in the toolbar itself, per the explicit ask that it sit next to the Prev/Next buttons where it stays in view.
- **7d** — `components/review/tally-footer.tsx`: `Info`-icon tooltips (first use of the tooltip primitive in this app) on "Entry (tenant)", "variance", the tolerance badge, and the line-items-vs-total checkmark. The tolerance tooltip text was checked verbatim against `lib/normalize.ts`'s `tallyWithinTolerance` doc comment:

  > *"Two amounts are 'within tolerance' when their absolute difference is no more than the tighter of a flat ₹1 and 0.05% of the larger amount. In practice that caps at a flat ₹1 for any realistic invoice (above ~₹2,000); below that, the 0.05% bound is the tighter (stricter) one."*

- **7e — noted, not built** (see Ideas below).

---

## Fixes made during verification (after merging all three implementation streams)

1. **"Extract now" flicker.** It called the same `onMutated()` used by attach/park (wired to `removeDocumentLocally`), which briefly removed the row before `router.refresh()` brought it back — extraction doesn't change match status, so the removal was never correct. Removed the `onMutated()` call from the extract-now handler in `document-card.tsx`; `router.refresh()` alone is sufficient.

2. **Reconciliation-exception constraint regression (pre-existing, unrelated to this plan, caught while touching the same constraint).** `20260811000003_entries_restructure.sql` renamed `ocr_total_vs_tenant_amount` → `ocr_total_vs_amount` and `tenant_vs_main_variance` → `department_vs_audit_variance`. A later, unrelated migration, `20260814000005_phase3_portal_ingest.sql`, dropped and recreated the same check constraint from a stale value list, silently reverting both renames — while `lib/jobs/handlers/extract.ts` has been raising the *new* name (`ocr_total_vs_amount`) ever since, which would violate the (reverted) constraint. Fixed in `20260814000010_document_extraction_vendor_email.sql`, which was already rebuilding this exact constraint to add `vendor_gstin_is_own_org` — it now uses the correct, current value list instead of copying the stale one.

---

## Ideas raised alongside the redesign artifact

### Already noted in the original plan, not built this pass

- **Draggable divider** between the PDF and form panes — no existing resizable-split primitive in the repo; worth it if the fixed 50/50 split still feels cramped once the sidebar-collapse (item 6) frees up width.
- **Collapsible header-fields section** once verified, to give line items more vertical room on tall invoices.
- **Focus mode** hiding the tally footer until Cmd/Ctrl+Enter, for reviewers who find the running totals distracting mid-entry.

### Additional ideas surfaced from reading the actual component tree

- **Consolidate "Extract now" and "Re-extract (R)".** Documents' new manual action and Review's existing keyboard shortcut both call `extractAndPersist` from two separate UI components. Worth eventually sharing one status/action component so the two screens can't drift into different copy or states.
- **Extend the Ctrl-K palette to jump to a review-queue position.** The base palette (`command-palette.tsx`) now exists and jumps straight to `/entries/{id}` — built this pass, see item 6's verification note above. It doesn't yet resolve to a position *within the `/review` queue*, so a search-based way into the queue is still a second path around the PgUp/PgDn boundary, not just a clearer boundary.
- **Reuse the Documents stage-tracker vocabulary on Review.** Review currently only shows a plain "Extracting…" toast; the four-stage tracker built for item 3/5 is a strictly better status language and would mean reviewers learn one vocabulary instead of two.
- **Keyboard-shortcut parity for the Documents table.** E / R / S / ? exist only on Review. Row-focus equivalents on the new table would make keyboard-first triage consistent across both screens instead of Review-only.
- **Click-to-focus exception pills.** The open-exception pills at the top of Review are currently read-only. Since most exception types are field-specific (GSTIN, total, etc.), making a pill click-to-focus the relevant field would turn a warning into a one-click fix.

---

## Outstanding

- ~~Set the real `COMMUNITY_GSTIN` value~~ — done.
- ~~Link the Supabase project~~ — done.
- ~~Apply the two new migrations~~ — done via `npx supabase db push --linked`; `20260814000010` and `20260814000011` are both confirmed applied remotely (`npx supabase migration list` shows every local migration matched on the remote).
- **Confirm the worker deployment decision** from the item-3 diagnosis: whether `npm run worker` needs to run persistently, or gets wired to a scheduler, so newly-uploaded PDFs keep reaching `/review` without relying on manual "Extract now" clicks. This is the only item left on this plan.
