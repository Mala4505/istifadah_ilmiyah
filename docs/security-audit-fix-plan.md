# Security audit & fix plan — 2026-10-15

Full security review of Istifadah Ilmiyah (Next.js 15 + Supabase, hosted on **Vercel only**). Six read-only
auditors across three models (Opus: route/action authz ×2, Sonnet: DB/RLS/storage + injection,
Haiku: secrets/transport + line-by-line verification), plus live read-only probes of production.
Every Critical/High item was re-verified against the code. Line numbers were current on 2026-10-15
(commit `a73cf17`). Re-read before editing, because they may drift.

**How to run this file:** execute one phase per session (`exe-now docs/security-audit-fix-plan.md phase N`).
Phase 0 is manual (dashboard) and is for the user, not the agent.

---

## Owner decisions (2026-10-15) — these are settled, don't re-ask

| # | Topic | Decision | Affects |
|---|---|---|---|
| D1 | Public signup | **Disabled** in dashboard. Live check 2026-10-15: `disable_signup=true` | 0.1 ✅, 1.1 |
| D2 | Hosting | **Vercel only.** No IIS/self-host, so read client IP from Vercel headers. The Next self-host cache advisory is low priority | 4.9, 7.3 |
| D3 | Dept users | **Planned, none exist yet.** Lock everything down now so it's safe the day they're added | 1.2, 2.x, 3.x |
| D4 | Dept visibility | Dept users **see:** own dept entries & bills, and the **vendor list incl. GSTIN/phone/address**. They **don't see:** board pack (admin+ only), flags & exceptions of other departments (scope to their own dept), import logs / status exports (admin+) | 2.4, 2.5, 3.6 |
| D5 | Closed events | **Superadmin only** may edit a closed event. Admins and dept are read-only there | 2.1, 2.2, 3.x |
| D6 | CSP | Add the anti-clickjacking header now. Enforce CSP **on a Vercel preview first**, have the user click through every screen, then switch production. User is non-technical, so give them a plain checklist of pages | 4.1, 4.2 |
| D7 | `Burhani Hospital.pdf` | **Real bill → purge from git history.** Repo is private, and the user is the only clone holder. Still needs explicit confirmation right before force-push | 7.1 |
| D8 | Login brute force | **Database lockout hook** (Supabase Auth `password_verification_attempt` hook). No captcha | 6.1 |
| D9 | Account features | **Self-service change password** + **sign out everywhere on deactivate**. No forced change on first login | 3.5, 6.2 |
| D10 | Cost caps | **No per-user caps.** Dropped. Suggest an Anthropic console monthly spend limit instead | — |
| D11 | Log retention | **Keep `api_request_log` forever.** No retention job | — |
| D12 | Scrape token TTL | **Keep 30 days.** Tokens must still die when the creating admin is deactivated/demoted | 3.5 |
| D13 | DB migrations | Session writes and tests locally, explains in plain English what changes, and **asks before `npx supabase db push`** | all DB phases |

---

## Rules for the executing session

1. **Do not commit or push** unless the user asks. Every subagent prompt must forbid git writes
   explicitly. Don't use Agent worktree isolation (broken in this repo).
2. **Migrations:** new files in `supabase/migrations/` named `20261015HHMMSS_<slug>.sql` (use the real date).
   Test locally, then **ask before** `npx supabase db push` (D13). Always `npx supabase`, never bare `supabase`.
3. Load the `supabase:supabase-postgres-best-practices` skill before writing SQL. Keep
   `security definer` + `set search_path = ''` on every function you touch.
4. User-facing errors must be plain English (`toastError` / `FriendlyError` / `friendlyDataError`).
   Log raw text server-side via `logRawError`. Never return `error.message` to the client.
5. After code changes: `npx tsc --noEmit`, the test suite, then `python -m graphify update .`.
6. Each task has an **Accept** line. The phase isn't done until every Accept holds.
7. The user is non-technical on security topics. Explain each change in one plain sentence when reporting.
8. Don't "fix" the items in **Verified clean** at the bottom. They were checked and are fine.
9. Tick the checkbox next to each task in this file when it's done and verified.

---

## Execution status — 2026-10-15 (exe-now, all phases)

**Written and passing offline** (`tsc`, lint, 739 unit tests, `npm run build`): every task in Phases 1-6 and 8, plus 7.2 and 7.3.
Nothing has been applied to the live project (no Docker here, only one Supabase project), so Accept lines that need the database or a deployed site are **not yet verified**.
Ticked above = fully done. Still unticked = code is written but waiting on one of these:

1. **User OK to `npx supabase db push`** (D13): 4 new migrations `20261015100000` (critical fixes), `20261015110000` (RLS hardening), `20261015120000` (login lockout hook), `20261015130000` (pending upload). Deploy the code right after (1.1 needs both together).
2. **Then `npm run test:rls`** to prove Phases 1, 2, 4.3, 6.1 live.
3. **4.2 CSP**: Vercel preview + user click-through (`docs/csp-preview-checklist.md`), then flip production.
4. **6.1 hook**: Supabase says this hook needs the **Team/Enterprise plan**; enable via `docs/login-lockout-hook-setup.md`.
5. **7.1 history purge**: DONE 2026-10-15. PDF removed from `master` history and force-pushed (only `master` contained it; the other 2 remote branches were untouched). Backup mirror: `../istifadah-backup.git`. `*.pdf` added to `.gitignore` (uncommitted). Test fixtures (`test/gold*.json`, `*.xlsx`) NOT purged; still awaiting the user's call. GitHub may cache old commit views; ask GitHub Support to purge if wanted.
6. **Dashboard checks**: Authentication → "Secure password change" must be OFF for the new `/account` change-password page (6.2).
7. `npm audit` on production dependencies: 0 issues. Remaining dev-only findings (vitest/esbuild/braces) need a breaking vitest upgrade; left alone.

---

## Severity summary

| Sev | ID | One-liner | Phase | Status |
|---|---|---|---|---|
| 🔴 Critical | C1 | Signup trigger trusts `user_metadata` → self-registered superadmin | 0, 1 | **Exposure closed** (D1). Trigger fix still required |
| 🟠 High | H1 | `invoice-documents` storage policies: any staff can list/download/**overwrite** every PDF | 1 | open |
| 🟠 High | H2 | `confirmVendorAlias` server action: no auth, writes via service role | 3 | open |
| 🟠 High | H3 | `delete_source_document` RPC: no visibility/event check → admin deletes others' documents | 1 | open |
| 🟠 High | H4 | `reescalate` route + `reExtractPage`/`reExtractField`: no visibility/event/verified check | 3 | open |
| 🟡 Med | M1 | Ingest `entryId` / `assignedTo` unscoped (service-role insert) | 3 | open |
| 🟡 Med | M2 | Closed-event read-only rule is cookie-based, no DB backstop | 2 | open |
| 🟡 Med | M3 | `document_extraction_delete` lets admin delete **verified** bills (via `setPageSkipOverride`) | 2 | open |
| 🟡 Med | M4 | `reconciliation_exception` RLS: delete / forge `resolved_by` / raise on invisible rows | 2, 3 | open |
| 🟡 Med | M5 | Scrape tokens survive creator's deactivation/demotion | 3 | open |
| 🟡 Med | M6 | `saveVerification` creates vendors before any role check | 3 | open |
| 🟡 Med | M7 | CSP is Report-Only **in production**, no `X-Frame-Options` → clickjacking open | 4 | open |
| 🟡 Med | M8 | CSV export formula injection (`=`/`+`/`-`/`@` cells) | 5 | open |
| 🟡 Med | M9 | Login rate limit bypassable by calling Supabase Auth directly | 6 | open |
| 🟡 Med | M11 | Board pack (org-wide financials) readable by `dept` users | 2, 3 | open |
| 🟡 Med | M12 | Prompt injection: PDF text can steer OCR; re-extract auto-dismisses `other` exceptions | 5 | open |
| 🟡 Med | M13 | Real financial PDF tracked in git history (`Burhani Hospital.pdf`) | 7 | open |
| 🟢 Low | M14 | `next` 15.5.26 cache-poisoning advisory (self-host only, D2), `source-map-js` DoS | 7 | open |
| 🟢 Low | L* | See phases 1–7 | — | open |

(M10 per-user cost caps was dropped per D10.)

---

## Phase 0 — Manual dashboard actions (USER does these; agent only verifies)

- [x] **0.1 (C1) Disable public signup.** Done. Verified live 2026-10-15: `/auth/v1/settings` → `disable_signup: true`.
  The app creates users via `auth.admin.createUser`, which still works.
- [ ] **0.2 (C1) Check for intruders.** Signup was open until 2026-10-15, so check nobody used it.
  Supabase Dashboard → SQL Editor → paste and run:
  ```sql
  select u.id, u.email, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
         sp.role, sp.is_active, u.raw_user_meta_data
    from auth.users u left join public.staff_profile sp on sp.id = u.id
   order by u.created_at desc;
  ```
  Every row must be someone a superadmin created (login emails look like `<ITS>@members.…`).
  **Red flags:** a real-looking personal email, `role = superadmin` you don't recognise, or
  `raw_user_meta_data` containing `"role"` without a matching admin-created account.
  If found: set `is_active=false`, delete the auth user, and tell the fix session so it can review
  `api_request_log` for that `user_id`.
- [ ] **0.3 Auth rate limits.** Dashboard → Authentication → Rate Limits: lower "sign-in / sign-ups" per IP
  (e.g. 30 per 5 min). This is a free first layer before Phase 6.
- [ ] **0.4 Bucket limits.** Dashboard → Storage → `invoice-documents` → edit bucket: file size limit 32 MB,
  allowed MIME `application/pdf`. (Phase 1 also sets this in SQL.)
- [ ] **0.5 Data sent to others.**
  - Anthropic console: confirm the data-retention setting for invoice content and set a **monthly spend limit**. This replaces per-user caps (D10).
  - GitHub repo → Settings → Actions → General → Workflow permissions = **Read repository contents**.
- [ ] **0.6 Secrets.** The local `.env` holds live keys (never committed). Rotate only if session transcripts
  are shared outside the team.

---

## Phase 1 — Critical/High database fixes (one migration)

File: `supabase/migrations/<date>_security_critical_fixes.sql`

### [ ] 1.1 (C1) `handle_new_user` must read server-only metadata
- **Where:** `supabase/migrations/20260819000003_role_rbac_v2.sql:223-250` (final definition).
  Caller: `lib/actions/admin.ts:68-79` (`createStaffUser` passes role/is_active in `user_metadata`).
- **Problem:** the trigger copies `role`, `is_active`, `department_ids`, `its_number` from
  `raw_user_meta_data`, which any signup caller controls. Signup is off now (D1), but if anyone ever
  re-enables it, the hole reopens instantly. User-editable metadata must never grant a role.
- **Fix (SQL):** redefine `private.handle_new_user()` to read `role`, `is_active`, `department_ids`,
  `its_number`, `contact_email` from `new.raw_app_meta_data`. Keep only `full_name` from
  `raw_user_meta_data`. Defaults stay `'dept'` / `false`.
- **Fix (code, same deploy):** in `createStaffUser`, move those keys from `user_metadata` to
  `app_metadata`, keeping `full_name` in `user_metadata`. Both must ship together, or new users land
  as inactive `dept`. Push the migration, then deploy the code immediately.
- **Accept:** on the local stack, `signUp` with `data:{role:'superadmin',is_active:true}` produces a
  `staff_profile` with `role='dept'` and `is_active=false`. `createStaffUser` still creates an active admin correctly.

### [ ] 1.2 (H1) Lock down `invoice-documents` storage
- **Where:** `supabase/migrations/20260808000027_storage_policies.sql:9-22`.
- **Problem:** select/insert/update only require `private.is_staff()`. Any logged-in user, including
  future dept users (D3), can `list()`/`download()` every department's invoices with their own token, and
  `upload(..., {upsert:true})` can replace a verified bill's PDF while the DB keeps the old `file_hash_sha256`.
- **Pre-check:** `grep -rn "storage.from(" app components lib`. Confirm every storage call runs on the
  service-role client (`lib/storage.ts`) or uses signed URLs. The audit found no browser-side authenticated
  storage calls; re-confirm.
- **Fix:**
  ```sql
  drop policy if exists "staff read documents"    on storage.objects;
  drop policy if exists "staff upload documents"  on storage.objects;
  drop policy if exists "staff replace documents" on storage.objects;
  drop policy if exists "admins delete documents" on storage.objects;
  update storage.buckets
     set file_size_limit = 33554432, allowed_mime_types = array['application/pdf']
   where id = 'invoice-documents';
  ```
  Signed upload URLs (`createSignedUploadUrl`) and signed read URLs keep working because they are issued by
  the service role.
- **Also update** `test/integration/rls.test.ts:704-720`. It currently asserts dept *can* upload/replace.
  Invert it to assert dept/admin **cannot** select/insert/update directly, and that anon cannot.
- **Accept:** inverted tests pass. Upload → ingest → preview → review flow works end-to-end in the browser.

### [ ] 1.3 (H3) `delete_source_document` must check visibility + current event
- **Where:** body `20261006140000_superadmin_delete_verified_document.sql:26-79`. Wrapper
  `20260820000001_delete_source_document.sql:109-125`. Caller `lib/actions/documents.ts:305-336`.
- **Problem:** the function is SECURITY DEFINER and only checks admin role (+ superadmin for verified). A
  non-superadmin admin can delete documents assigned to other admins or in closed events. That cascades
  extractions, line items and rate history, and the action then deletes the PDF with the service key.
- **Fix:** at the top of `private.delete_source_document` (closed events: superadmin only, D5):
  ```sql
  if not (select private.can_see_source_document(p_id)) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not (select private.is_superadmin()) and not exists (
       select 1 from public.source_document sd join public.event e on e.id = sd.event_id
        where sd.id = p_id and e.is_current) then
    raise exception 'event is closed' using errcode = '42501';
  end if;
  ```
  Verify the helper name/signature in the latest migration before using it. Apply the same guards to
  `cancel_source_document_jobs`.
- **Accept:** RLS test: admin A cannot delete a document assigned only to admin B. An admin cannot delete in a closed
  event, and a superadmin can.

### [ ] 1.4 (L11) Revoke anon EXECUTE on definer wrappers
```sql
revoke execute on function public.delete_source_document(bigint)                  from public, anon;
revoke execute on function public.cancel_source_document_jobs(bigint)             from public, anon;
revoke execute on function public.set_source_document_assignees(bigint[], uuid[]) from public, anon;
revoke execute on function public.next_manual_ubbl_number()                        from public, anon;
```
Check exact signatures first in the defining migrations: `20260820000001:124,174`, `20260829000002:218`,
`20260819000002:46`. Each checks the role internally, so impact today is low.
- **Accept:** after push, Dashboard → Advisors → Security shows no anon-executable SECURITY DEFINER warnings for these.

---

## Phase 2 — Medium database fixes (one migration)

File: `supabase/migrations/<date>_security_rls_hardening.sql`

### [ ] 2.1 (M2) Closed events read-only in the DB (D5: superadmin may still edit)
- **Problem:** the "closed event is read-only" rule checks `isEventMutable(getSelectedEvent())`, which is the
  user's own `active_event_id` cookie. It then writes whatever id the client sent (`review.ts:209`,
  `entries.ts:308-317, 413-420`, `entry-enrichment.ts:52,113,205,269`). Many actions don't check at all
  (saveEntryClassification, setPageSkipOverride, createManualBillForPage, addLineItem, flagReviewException,
  resolveException(s), resolveFlag, manualExtractNow). `entries_update` (`20261005120000:120`) has no
  event predicate, and `verify_document_extraction` has no `is_current` check.
- **Fix:**
  ```sql
  create or replace function private.event_writable(eid bigint) returns boolean
  language sql stable security definer set search_path = '' as $$
    select (select private.is_superadmin())
        or coalesce((select e.is_current from public.event e where e.id = eid), false) $$;
  ```
  - Add `and (select private.event_writable(event_id))` to `using` **and** `with check` of `entries_update`,
    and to entries insert/delete policies if they exist.
  - In `verify_document_extraction`, `set_bill_entry_links`, `add_bill_entry_link` and every write RPC on
    document data: resolve the document's event and raise unless `private.event_writable(...)`.
  - Write policies on `document_extraction`, `document_extraction_line_item`, `reconciliation_exception`
    and `flags`: add the same predicate via the parent document's or entry's event.
- **Accept:** RLS tests:
  - An admin cannot update an entry or verify an extraction in a non-current event, even with a forged `active_event_id` cookie.
  - A superadmin can.
  - Current-event writes are unaffected.

### [ ] 2.2 (M3) Verified extractions can only be deleted by superadmin
- **Where:** `document_extraction_delete` policy (`20260822000009`, altered `20261005120000:282`).
  `clear_bill_rate_reference_links` (`20260914000002`). Trigger path `review.ts:1307-1338` (`setPageSkipOverride`).
- **Fix:** add `and ((select private.is_superadmin()) or verified_at is null)` and the 2.1 event predicate to
  `document_extraction_delete`. Put the same guard inside `clear_bill_rate_reference_links`.
- **Accept:** an admin "skip page" on a verified single-page bill fails with a friendly message; a superadmin can do it.

### [ ] 2.3 (M4 + D4) `reconciliation_exception` and `flags`: integrity + department scope
- **Where:** insert `20260813000003:13`, update `20260808000026:352`, delete `20260912000002:36`, flags policies
  in `20260808000026`.
- **Fix:**
  - Revoke delete from authenticated and drop the delete policy. If deletion is needed, use a superadmin-only RPC.
  - Add a `before update` trigger. When status changes to resolved, force `resolved_by := auth.uid()` and
    `resolved_at := now()`. Disallow changing `exception_type`, `document_extraction_id` and `entry_id`.
  - **Select** (D4): admin+ sees all. Dept sees only rows whose entry or document is visible to them
    (`private.can_see_entry(entry_id)` / `private.can_see_document_extraction(document_extraction_id)`).
    Confirm helper names first.
  - **Insert/update** `with check`: the target must be visible to the caller (same helpers).
- **Accept:** RLS tests cover:
  - Delete is denied.
  - A forged `resolved_by` is overwritten.
  - An insert on an invisible extraction is denied.
  - A dept user sees only their own dept's exceptions and flags.

### [ ] 2.4 (M11 + D4) Board pack admin-only
- **Where:** `board_pack_select_staff` (`20260903000017:72`) and the `board-packs` storage select policy (`:92`).
- **Fix:** change both to `(select private.is_admin_or_above())`.
- **Accept:** an RLS test shows a dept user can't read `board_pack` rows or `board-packs` objects.

### [ ] 2.5 (D4) Other staff-wide tables
Readable by every active staff member today (`20260808000026:118-345`). Apply D4:

| Table | Dept users | Change |
|---|---|---|
| `vendor`, `vendor_alias`, `rate_reference` | **keep visible** (D4: vendor list incl. GSTIN allowed) | none |
| `import_batch`, `import_row_log`, `status_export_*` | admin+ only | gate select with `private.is_admin_or_above()` |
| `app_settings`, `approval_threshold` | check what the UI needs | if any dept-visible screen reads them, keep select; otherwise admin+ |

Before gating, grep each table name in `app/` and `components/` to make sure no screen a dept user can open
breaks. A screen that breaks should hide its panel for dept, not error.

### [ ] 2.6 (L17) `staff_profile` self-update columns
`staff_profile_update` (`20260819000003:195`) blocks role/is_active changes, but a user can still rewrite their own
`its_number` / `contact_email`. `its_number` is their login identity. Pin both in the `with check`
(unchanged unless superadmin), or use column-level `grant update (display_name)`.

---

## Phase 3 — Server action & route authorization (code)

Add a shared helper, e.g. `lib/auth/scope.ts` (server-only):
```ts
// Session-client (RLS) visibility + writable-event check before any admin-client work.
// Closed events are writable by superadmin only (D5).
export async function assertDocumentWritable(sourceDocumentId: number, role: StaffRole) {
  const supabase = await createClient()
  const { data } = await supabase
    .from('source_document').select('id, event:event_id(is_current)')
    .eq('id', sourceDocumentId).maybeSingle()
  if (!data) return { ok: false as const, reason: 'not_found' }
  if (!data.event?.is_current && role !== 'superadmin') return { ok: false as const, reason: 'closed_event' }
  return { ok: true as const }
}
```
Add an `assertExtractionWritable(documentExtractionId)` / `assertEntryVisible(entryId)` variant too.
Remember: **every export in a `'use server'` file is a public POST endpoint**, whether or not the UI calls it.

### [ ] 3.1 (H2) `confirmVendorAlias` — `lib/actions/review.ts:1180-1202`
Add `requireAdminOrAbove()` as the first line, or the active-staff + reviewer gate used elsewhere. Verify that
`vendorId` exists via the session client.
*Accept:* an unauthenticated POST with the action id gets a denial and creates no `vendor_alias` row.

### [ ] 3.2 (H4) Re-extraction paths
- **Where:**
  - `app/api/documents/reescalate/route.ts:38-63`
  - `lib/actions/review.ts:1398-1428` (`reExtractPage`) and `:1560-1589` (`reExtractField`)
  - Handlers in `lib/jobs/handlers/rescope-extract.ts:124,304`
- **Fix:**
  - Run `assertDocumentWritable` / `assertExtractionWritable` before `createAdminClient()`.
  - Refuse when the extraction is already verified, unless the caller is a superadmin.
  - Copy the pattern from `createManualBillForPage` (`review.ts:1440-1471`).
- **Accept:** admin A gets "not found" when re-extracting a doc assigned only to admin B. Closed-event docs (for non-superadmin) and verified docs are refused.

### [ ] 3.3 (M1) Ingest scoping — `app/api/documents/ingest/route.ts`
- `entryId` (`:248-253`, insert `:318-327`): before the admin insert, read the entry with the **session**
  client, filtered by `event_id = <document event>`. Require admin-or-above, matching `assert_entry_bill_link_allowed`.
  Alternatively, call `add_bill_entry_link` on the session client instead of a raw admin insert.
- `assignedTo` (`:338-369`): ignore it unless the caller is admin-or-above.
- Page count fallback (`:208-209`): if the `pdf-lib` parse fails, reject the upload instead of trusting the client's `pageCount`.
- *Accept:* a dept user posting another department's `entryId` gets a friendly 403 and no link row is created.

### [ ] 3.4 (M6) `saveVerification` — `review.ts:196-224`
Move `getStaffContext()` + the active and reviewer-role check and `assertExtractionWritable(documentExtractionId)`
**before** `resolveOrCreateVendorForVerifiedName` (`:129-183`).

### [ ] 3.5 (M5 + D9 + D12) Scrape tokens & deactivation
- `lib/scrape-token.ts:136-187` `verifyScrapeToken`: join `staff_profile` on `created_by` and require
  `is_active` and role in (`admin`,`superadmin`). Keep `MAX_TOKEN_TTL_HOURS = 720` (D12).
- `lib/actions/admin.ts` `updateStaffProfile` (~166): when deactivating a user, or demoting them below admin:
  - Revoke all their scrape tokens.
  - Call `admin.auth.admin.signOut(userId, 'global')` to kill sessions on every device (D9). If that API
    needs the user's JWT rather than the id in the installed supabase-js version, use
    `auth.admin.updateUserById(id, { ban_duration: '876000h' })` on deactivate and `'none'` on reactivate.
- *Accept:* deactivate an admin → their bookmarklet token is rejected on the next use, and their open browser session is logged out.

### [ ] 3.6 (M11, L4) Board pack actions — `app/(app)/reports/board-pack-actions.ts`
`getBoardPackDownloadUrl` (`:40-63`) → `requireAdminOrAbove()` (D4).
`getBoardPackJobStatus` (`:122-131`) → `requireAdminOrAbove()` + `.eq('job_type','board_pack')`.
Hide the board-pack UI entry for dept users.

### [ ] 3.7 (M4 code side) Exceptions & flags
- `flagReviewException` (`review.ts:583-612`): zod `reason: z.enum(['not_clear','not_visible','other'])`, and run `assertExtractionWritable` first.
- `resolveException(s)` / `resolveFlag`: zod-validate `outcome` (disallow `'open'` where not intended) and check the target's visibility.

### [ ] 3.8 Lower-severity action fixes
- **L1** `manualExtractNow` (`lib/actions/documents.ts:86-116`): refuse when the document is verified or its event is closed (non-superadmin).
- **L2** `replaceProvisionalUbblNumber` (`entries.ts:418-422`): add `.eq('source','manual').like('ubbl_number','M-%')`.
  The UBBL number is the Excel two-way matching key, so imported numbers must never be rewritten.
- **L3** Foreign-key department checks:
  - `createManualEntry` (`entries.ts:235`): verify `budgetHeadId` belongs to `departmentId`.
  - `saveEntryClassification`: verify `subDepartmentId`.
  - `setSettlesEntry`: verify the target is a visible `advance_payment` entry in the same event.
- **L19** Add zod validation for raw ids/enums in:
  - `setActiveEvent`, `updateStaffProfile`, `setReviewQueueScope`
  - `mergeVendor`, `unmergeVendor`, `setVendorConfirmed`, `updateBudgetHeadMapping`
  - `saveKeymapPreferences` (cap the `binding.key` length)

  Also, `mergeVendor` must reject merging a vendor that is itself a merge root with aliases.

---

## Phase 4 — HTTP hardening (headers, routes, errors)

### [ ] 4.1 (M7) Anti-clickjacking + API headers (zero-risk, do first)
In `next.config.ts` `headers()`:
- Add `X-Frame-Options: DENY` for `/:path*`. It works even while CSP is report-only.
- Add an `/api/:path*` entry with HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy` and `Cache-Control: no-store`.
  The middleware matcher (`middleware.ts:122-126`) skips `/api`, so API responses get none of these today.

*Accept:* `curl -sI https://<preview>/login` shows `X-Frame-Options: DENY`, and `/api/documents/status` shows the API headers.

### [ ] 4.2 (M7 + D6) CSP enforcement: preview first
CSP = the browser rule list that blocks any script not from this site. Today it only reports violations. It's a
safety net that stops a future XSS bug from stealing data from a logged-in admin.
1. Read `docs/csp-enforcement-readiness.md`. Check recent CSP violation reports (Sentry, or wherever
   `report-uri`/`report-to` points in `middleware.ts`) and fix the policy for legitimate sources.
2. Deploy a **Vercel preview** with `CSP_REPORT_ONLY=false` (Preview env scope only).
3. Give the user a plain checklist to click through on the preview: login, dashboard, entries (filters + CSV export),
   documents upload, review (PDF viewer, zoom, line items, save), reports (every chart page), board pack download,
   admin/settings, import page (incl. bookmarklet drag-link). Ask them to report anything blank or broken.
   Check the browser console for `Refused to …` errors yourself if a browser tool is available.
4. Once the user confirms it's clean, set `CSP_REPORT_ONLY=false` in Production and redeploy. Then flip the default in
   `lib/env.server.ts:28-32` to `'false'`.

*Accept:* `curl -sI https://istifadah-ilmiyah.vercel.app/login` shows `Content-Security-Policy:` (not `-Report-Only`), and the user has confirmed the checklist.

### [ ] 4.3 Route hygiene
- **Tick** (`app/api/jobs/tick/route.ts:44-49,66`): GET accepts **only** the cron secret. Admin-session drains go through POST only.
- **CSRF** — JSON routes (`ingest:121`, `reescalate:47`, `scrape-token:74`, `import/portal:111`):
  - Reject unless `content-type` starts with `application/json`.
  - For cookie-authenticated routes, also check that `Origin` matches `NEXT_PUBLIC_SITE_URL`.
- **Portal** (`import/portal/route.ts:110-177`): authenticate (bearer/session) **before** `request.json()`. Reject
  `content-length` > 4 MB first.
- **XLSX imports** (`import/route.ts:94-100`, `department-budget:69-75`, `sub-department-budget:71-77`):
  - Reject `file.size` > 10 MB before `arrayBuffer()`.
  - Pass a `sheetRows` cap to `XLSX.read`.
- **Ingest** (`ingest/route.ts:154-175`): check the object size via storage metadata before `getDocumentBytes`
  downloads it. Wrap `PDFDocument.load` (`lib/pdf.ts:104-108`) in a timeout.
- **Upload URLs** (`upload-url/route.ts` / `lib/storage.ts:75-82`): record each issued upload path against `user.id`
  (a pending-upload row). Ingest rejects finalising a path issued to another user.

*Accept:* route tests return 415 for the wrong content-type and 413 for oversize; an unauthenticated portal call gets 401 without the body being parsed.

### [ ] 4.4 (L1) Raw errors → friendly text
Return generic plain-English text and log the raw error with `logRawError`:
- `ingest/route.ts:159,306,382,428`
- `upload-url/route.ts:89`
- `status/route.ts:75,78`
- `reescalate/route.ts:78-80`
- `scrape-token/route.ts:84,108,147`
- `import/portal/route.ts:122,210`
- `import/route.ts:135,138`
- `department-budget/route.ts:96`
- `sub-department-budget/route.ts:98`
- `lib/actions/documents.ts:489` and `review.ts:564` (signed-URL errors include `storage_path`)

### [ ] 4.5 Small server hardening
- `lib/storage.ts:1`: add `import 'server-only'`.
- Client IP (D2, Vercel only): in `lib/actions/auth.ts:19-20` and `lib/api-log.ts:7-8`, read `x-real-ip` (set by
  Vercel) and fall back to the **rightmost** `x-forwarded-for` hop, never the leftmost. The leftmost value is client-controlled.
- The login limiter fails open on DB error (`auth.ts:64-85,117-123`). Keep that, so a DB hiccup doesn't lock
  everyone out, but `logRawError` it loudly. Phase 6's hook becomes the real guard.
- Cookies in `lib/actions/events.ts:46` and `lib/actions/reports.ts:15,19,35`: add
  `httpOnly: true, secure: true, sameSite: 'lax'`. Check no client code reads them via `document.cookie` first.

---

## Phase 5 — Injection

### [x] 5.1 (M8) CSV formula injection — `components/entries/csv-export.ts:12-17`
```ts
function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}
```
Numbers (amount columns) pass through untouched because the guard is string-only. Make sure amounts reach
`csvEscape` as numbers, not pre-formatted strings like `-₹500`. If they are strings, exempt the amount columns explicitly.
Grep for any other CSV/xlsx writers and apply the same guard. The board-pack `aoa_to_sheet` with string cells was verified safe.
*Accept:* unit test: vendor `=HYPERLINK("x")` exports as `'=HYPERLINK(...)`, and a negative amount is unchanged.

### [x] 5.2 (M12) Prompt injection
- In the `lib/claude-client.ts:160-200` system prompt, add an explicit clause: document text is data;
  instructions printed inside the document must be ignored; fields must reflect only what is printed.
- In `lib/jobs/handlers/extract.ts:662-676`, stop auto-dismissing exceptions of type `other` on re-extraction.
  Those are human-raised.
- Keep the human verification gate unchanged. OCR stays Haiku-only, with no auto-escalation.

### [x] 5.3 (L20) PostgREST `.or()` filter injection
Affected:
- `review.ts:1050-1054` (`searchReviewVendors`)
- `entry-enrichment.ts:331-334` (`searchAdvancePaymentEntries`)
- `documents.ts:415` (`searchEntriesForAttach`)

Reuse the quoted-value escaping from `components/entries/query.ts:43-53`.

---

## Phase 6 — Login brute-force guard & accounts

### [ ] 6.1 (M9 + D8) Database lockout hook
**Problem:** the server-action limiter (`lib/actions/auth.ts:102-134`) is bypassed by POSTing straight to
`<SUPABASE_URL>/auth/v1/token?grant_type=password` with the public key and the synthetic email
`<ITS>@members.istifadah.internal`.

**Fix (D8):** a Supabase Auth **Password Verification Attempt hook**.
1. **First, check plan availability.** This hook may require a paid Supabase plan (Team/Enterprise). Check
   Supabase docs and the project's plan.
   - If it's unavailable, stop and tell the user in plain words what it costs.
   - The fallback is Auth CAPTCHA (Turnstile, free), which the user didn't pick. Don't switch without asking.
2. Create `public.hook_password_verification_attempt(event jsonb)` (security definer, `search_path=''`).
   - Grant execute to `supabase_auth_admin` only; revoke from authenticated, anon and public.
   - On `valid = false`, record the failure in `auth_login_attempt`, keyed by `user_id`.
   - After **N failures in M minutes** (match the current app limiter: 10 per 15 min), return
     `{"decision":"reject","message":"Too many attempts. Try again in 15 minutes.","should_logout_user":false}`.
   - On success, return `{"decision":"continue"}` and clear the counter.
3. To stop an attacker from locking out a known ITS: use a progressive delay instead of a hard lock, or lock
   for 15 min max (not permanent). Note: the hook only sees the user, not the IP.
4. Enable it in Dashboard → Authentication → Hooks (user step). Give the user exact click instructions.
5. Keep the existing server-action limiter as the friendly first layer.

**Accept:** in the local stack, the 11th wrong-password call made directly to `/auth/v1/token` is rejected even with the right password, and it succeeds again after the window.

### [ ] 6.2 (D9) Self-service change password
- Add a "Change password" form under the user's own settings/profile screen.
- Server action: re-check the current password with `signInWithPassword` first, then call `supabase.auth.updateUser({ password })`.
- Apply the same min-length rule as `lib/generate-password.ts` (≥10 characters).
- Show plain-English messages for wrong-current-password and too-short.
- No forced change on first login (D9).

---

## Phase 7 — Repo, CI & dependencies

### [x] 7.1 (M13 + D7) Purge `Burhani Hospital.pdf` from git history
The repo is private, and the user is the only clone holder (D7). This is still irreversible, so **confirm with the user right
before the force-push**, and first check that no cloud session is committing to this repo.
1. Backup: `git clone --mirror <remote> ../istifadah-backup.git`.
2. `pip install git-filter-repo` (if missing), then `git filter-repo --invert-paths --path "Burhani Hospital.pdf"`.
3. Add `*.pdf` to `.gitignore`. Add `!public/**/*.pdf` only if public PDFs are ever needed; there are none today.
4. Check `test/gold*.json` and `test/*.xlsx` fixtures for real vendor data. Ask the user before purging those too.
5. Re-add the remote (filter-repo removes it), then `git push --force --all && git push --force --tags`. **User confirmation required.**
6. GitHub may keep cached views of old commits. If needed, the user can ask GitHub Support to purge cached data.

### [x] 7.2 CI workflow — `.github/workflows/worker.yml`
- Add top-level `permissions: contents: read`.
- Pin `actions/checkout@v5` and `actions/setup-node@v5` (`:51-52`) to full commit SHAs.
- Remove `DATABASE_URL` (`:60-68`) if the worker path doesn't use it (grep `worker/` and `lib/jobs/`).

### [x] 7.3 (M14) Dependencies
- Update `next` within 15.x to the latest patch (Vercel-hosted, so the self-host advisory is low priority, but stay current).
- Refresh `source-map-js` with `npm audit fix` (lockfile only).
- Then run the full test suite + `npm run build`.

---

## Phase 8 — Regression tests (lock it in)

Extend `test/integration/rls.test.ts` (1553 lines today) to cover what the audit found missing:
- Signup with escalated metadata → inactive `dept` (C1)
- Storage: dept/admin cannot list/download/upload/replace `invoice-documents` directly; anon cannot either (H1)
- `delete_source_document`: cross-assignee and closed-event denial; superadmin allowed in closed events (H3, D5)
- `source_document`, `document_page`, `document_extraction` and line items: department + assignee scoping
- Closed-event write denial on entries and the verify RPC; superadmin allowed (M2, D5)
- Admin denied deleting a verified extraction (M3)
- `reconciliation_exception` and `flags`: delete denied, forged `resolved_by` overwritten, invisible insert denied, dept scoping (M4, D4)
- `board-packs` bucket and `board_pack` table admin-only (M11)
- `import_batch` / `import_row_log` / `status_export_*` admin-only (D4)
- Anon EXECUTE sweep over every `public` function; anon SELECT sweep over every `public` table
- `scrape_token`, `app_settings`, `auth_login_attempt`, `api_request_log` policies

Add an action-level test that imports every export of every `'use server'` file and asserts that each one returns
a denial when called with no session. That catches the next `confirmVendorAlias`.

---

## Needs confirmation (couldn't be verified from code)

- Live grants/advisors: the claude.ai Supabase connector can't access project `lkxdlnqviftoicjcbswz`. After the
  Phase 1 & 2 pushes, the user runs Dashboard → Advisors → Security and pastes the results.
- The `private` schema is absent from PostgREST exposed schemas (Dashboard → API → Exposed schemas).
- `@supabase/ssr` cookie flags at runtime (expect HttpOnly, Secure, SameSite=Lax).
- JWT expiry / refresh token lifetime settings.
- `lib/export/` contains only `auth.ts`, with no Excel status export generator. Confirm that's intended.
- Whether rate_reference FKs preserve verified line values when `reescalate` replaces line items.

## Verified clean — don't re-flag

- **Transport:** HTTPS only. HSTS (2y, includeSubDomains, preload), nosniff, Referrer-Policy and Permissions-Policy are
  live in prod. No `http://` API URLs. Supabase encrypts the DB and storage at rest.
- **Secrets:** none committed, now or in history. No secret behind `NEXT_PUBLIC_*`. `server-only` is in
  `admin.ts`, `env.server.ts`, `claude-client.ts` and `queue.ts`. `.mcp.json` has no token.
- **Anon (live-probed 2026-10-15):** can't list the bucket; no public object URL; `staff_profile` returns 0 rows.
- **RLS:**
  - Enabled on all 55 public tables, with no `using (true)` and no policies granted to anon/public.
  - All 64 views are `security_invoker`.
  - All 47 SECURITY DEFINER functions set `search_path = ''`.
  - Users cannot self-promote.
- **Storage reads in app:** signed URLs (5 min) are issued only after an RLS visibility check. The bucket is private.
- **Ingest:** strict path regex (no traversal), PDF magic bytes, 32 MB cap, server-side hash, page cap.
- **Cron:** `CRON_SECRET` is compared with `timingSafeEqual` and fails closed.
- **Scrape tokens:** 256-bit random, SHA-256 hashed at rest, constant-time compare, `no-store`, no CORS credentials.
- **XSS:** both `dangerouslySetInnerHTML` uses are static/developer-controlled. No `href`/`src` is built from DB/OCR data.
  The bookmarklet escapes via `esc()`. No open redirects.
- **PDF.js and xlsx:** PDF.js 4.10.38 (past the CVE-2024-4367 fix) runs with `isEvalSupported: false`. xlsx 0.20.3 is patched.
- **Other:** no SSRF, no mass-assignment spreads, no SQL string concatenation, and login errors are generic.
- **Sentry:** `sendDefaultPii` is off and request bodies aren't sent. Logs carry ids/statuses, not document content.
- **Data egress (by design):** every bill PDF goes to Anthropic for OCR, and through GitHub-hosted runners
  when the worker runs there.
