# Istifada Ilmiyah Financial Hub — Master Plan v2

**Supersedes:** `~/.claude/plans/twinkling-juggling-hartmanis.md`
**Date:** 2026-08-08
**Deadline:** 7 days, hard constraint. Scope is cut explicitly in §12 — nothing is quietly dropped.

---

## 0. Decisions locked

| Question | Decision |
|---|---|
| Budget heads | **Two separate dimensions, not merged.** `head` = the 42 from `master.xlsx` (Hub-internal). `budget_head` = whatever the source system sends (`Venue setup (AVIT)`). A nullable `budget_head.head_id` is built now so merging later is filling in ~10 values in one screen, not a migration. |
| Hub scope | **Read, verify, report — plus two Hub-owned statuses.** No approval workflow, no payment recording: those stay in Departmental/Main and are imported as fact. But **`awaiting verification` and `awaiting validation` are set in the Hub portal and exported back to the modules.** These two are the only fields that flow outward. Everything else is one-way in, via import/API. |
| Volume | **1,000–10,000 entries** for the full event. Drives: keyboard-first review (§7), department-scoped RLS, batch OCR. |
| Delivery | **7 days, hard.** Deployed and usable by real staff at day 7. §12 states what does not make it. |

---

## 1. What changed from v1, and why

v1 opened with *"every schema decision was cross-checked against the real files — nothing here is speculative."* Six load-bearing claims failed against the files in this folder. All six are corrected below.

| v1 said | Correction |
|---|---|
| `venue` table, 13 rows, "global — used across every department" | It is **ZONE**, not venue. `master.xlsx` heading: *"VENUE SETUP – ZONE AND EXPENSE HEAD"*. Zones are Venue-Setup-scoped, not global. Zone 13 is `OFFICE EXPENSE` — not a place. Renamed `zone`, scoped to a department. |
| `AVIT` and `Tazyeen` are the two unmatched Budget Heads | The export has **10 coarse heads**; `master.xlsx` has **42 granular ones**. Exactly one (`Security`) matches by name. This is a dimension mismatch, not an exception queue. Per your decision, both dimensions now exist side by side. |
| Main export shape "not in hand yet" | Sheet 2 of the export is **`Main Reconciliation`**, fully headed: `Type │ Budget Head │ Department │ Vendor │ Invoice Number │ Tenant Amount │ Main Amount │ Difference (Tenant − Main) │ Tenant Status │ Main Status │ Reason │ UBBL Number │ Main Entry Number`. It is empty only because row 2 says *"Tenant pushed-only export reconciles cleanly with Main."* The contract is written down. It also settles the `Type` column v1 deferred. |
| Budget burn rate needs "no new table" | The export carries `Request Amount`, `Approved Amount`, `Utilised Amount`, `Balance` per head. There was nowhere to store an allocation. **`budget_allocation` added.** |
| `entries.amount` — one amount | The reconciliation contract needs **Tenant Amount, Main Amount, and their difference**. `entries` now carries both plus a generated variance. |
| Day 6: run all 21 invoices through the pipeline | Only **3 of 21** PDF vendors appear in the export, and not 1:1. ~18 documents have no entry to attach to, yet `source_document.entry_id` was `not null`. **Nullable + a document inbox** with a matching workflow. |

Also fixed: the parse rule *"skip rows with no vendor / zero amounts"* would have deleted the five heads carrying ₹5,000,000 each and zero spend — ₹2.5 crore of budget silently dropped. The `Grand Total` marker is in **column C**, not A. And `ADP_202608054` appears as a UBBL Number on one row and a Main Entry Number on another — the two ID namespaces overlap, so nothing may join on a bare "number".

**Kept from v1 unchanged** — these were right: the `_ocr` / `_verified` twin-column pattern (non-destructive by construction), server-side `updated_by` trigger, `flags.dedup_key` unique, `text + CHECK` over native enums, `(select auth.uid())` RLS wrapping with `SECURITY DEFINER` helpers in a `private` schema, storing `raw_response_jsonb` so reprocessing never re-bills, client-side pdf.js over a Deno rasteriser, and the honest note that pattern-based analytics need history first.

---

## 2. Stack

Named explicitly, because four of seven days are UI days and v1 named no framework.

| Layer | Choice | Why |
|---|---|---|
| Backend | Supabase — Postgres + Auth + Storage + Edge Functions | Already chosen. Auth + RLS + Storage in one, which is most of days 3 and 5. |
| Frontend | **Next.js 15 (App Router) + TypeScript** | Server components keep the list views fast at 10k rows without building an API layer. |
| Data access | `@supabase/ssr` | Cookie-based sessions that work in server components. RLS enforced in the database, not the client. |
| UI | Tailwind + shadcn/ui + TanStack Table | Unstyled, keyboard-accessible primitives. The review screen needs custom keyboard handling — a heavy component library fights that. |
| PDF | pdf.js in the browser | Rasterisation client-side. A Deno rasteriser is an unverified dependency on the day-1 critical path. |
| OCR | Claude API — `claude-haiku-4-5` first pass, `claude-sonnet-5` on escalation | §8. |
| Server logic | **Next.js Route Handlers + a plain Node worker** — *not* Supabase Edge Functions | Deno Edge Functions cannot run on your server. Plain Node runs anywhere. |
| Background work | **Postgres job queue** (`FOR UPDATE SKIP LOCKED`) | Vercel Cron drains it now; a Windows Service will run it continuously later. **Identical handler code.** |
| Hosting | **Vercel free tier now → your Windows Server when provisioned**; Supabase cloud throughout | §13. The server isn't ready yet, so week 1 ships on Vercel free. Job queue in Postgres + Batch API for async work keep function duration under control. If build/bandwidth limits are hit, upgrade to Pro ($20/month) as needed. Every design choice keeps server migration to ~1 day. |
| Errors | Sentry free tier | 20 minutes to wire. Without it, day-7 failures are invisible. |

**Environments:** one Supabase project for dev + prod. Secrets live in Vercel's environment settings today and as machine-level env vars / NSSM service definitions on the Windows Server later, plus a git-ignored `.env.local` on your dev machine — never in the repo. `ANTHROPIC_API_KEY` is server-side only; the browser never sees it. **Use identical variable names in both hosts** so the move is a copy-paste, not a refactor. Mitigation: always `dry_run` imports first; back up before major schema tests; use separate database schemas (`public.*` for prod, `test.*` for dev data) if needed.

**Backups:** Supabase daily automated backups on, plus a `pg_dump` to local storage before each import run on prod. A financial system without a tested restore is not deployed — restore once into `dev` on day 7 and record the runbook steps.

---

## 3. Data model

Conventions: `bigint generated always as identity` PKs; `timestamptz`; `numeric(14,2)` money (INR throughout — no multi-currency); enums as `text + CHECK`; every FK indexed; RLS wraps `auth.uid()` in `(select …)`; admin checks via `SECURITY DEFINER` helpers in a `private` schema.

### 3.1 Organisation and dimensions

```sql
create table public.department (
  id bigint generated always as identity primary key,
  name text not null unique,
  external_code text unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
-- seed: id=1 'Venue Setup'. More arrive via import with zero schema change.

-- The 42 granular heads from master.xlsx. Hub-internal. NOT the source system's heads.
create table public.head (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  head_number int not null,              -- 1..42, staff refer to these by number
  name text not null,
  is_active boolean not null default true,
  unique (department_id, head_number),
  unique (department_id, name)
);
-- seed: 42 rows under department_id=1, head_number/name exactly as in master.xlsx

-- ZONE, not venue. Scoped to the department, because master.xlsx scopes it to Venue Setup.
create table public.zone (
  id bigint generated always as identity primary key,
  department_id bigint not null references public.department(id),
  zone_number int not null,              -- 1..13
  name text not null,
  is_active boolean not null default true,
  unique (department_id, zone_number)
);
-- seed: 13 rows under department_id=1. Note zone 13 = 'OFFICE EXPENSE' — a bucket, not a place.

-- The source system's OWN budget-head dimension. Auto-created on import.
-- head_id stays null until you decide to merge the two dimensions.
create table public.budget_head (
  id bigint generated always as identity primary key,
  department_id bigint references public.department(id),
  raw_label text not null unique,        -- 'Venue setup (AVIT)' exactly as exported
  short_label text,                      -- 'AVIT' — parsed from the parentheses
  head_id bigint references public.head(id),   -- the future merge point; null for now
  first_seen_batch_id bigint,
  created_at timestamptz not null default now()
);
create index budget_head_head_idx on public.budget_head (head_id);
```

**Why this shape:** the merge you deferred becomes an admin screen listing ~10 `budget_head` rows with a dropdown of 42 heads. No migration, no reprocessing, no data loss. If you decide never to merge, nothing breaks — the two dimensions just report separately.

### 3.2 Vendor identity

v1 dropped the vendor table but kept the vendor-clustering flag that depends on it. Free-text vendor also splits the rate benchmark the moment a name is spelled two ways — and the sample already contains `Poonam Ajay kumar Sharma (Poonam Devi Sharma)`, an alias baked into a name field.

```sql
create table public.vendor (
  id bigint generated always as identity primary key,
  display_name text not null,
  normalized_name text not null unique,  -- lower, punctuation/whitespace stripped, legal suffixes removed
  gstin text,
  phone text,
  address text,
  bank_account_last4 text,
  cluster_group_id bigint references public.vendor(id),  -- self-ref; null = not clustered
  is_confirmed boolean not null default false,           -- true once a human has reviewed the identity
  created_at timestamptz not null default now()
);
create index vendor_gstin_idx on public.vendor (gstin) where gstin is not null;
create index vendor_phone_idx on public.vendor (phone) where phone is not null;
create index vendor_cluster_idx on public.vendor (cluster_group_id);

create extension if not exists pg_trgm;
create index vendor_trgm_idx on public.vendor using gin (normalized_name gin_trgm_ops);

create table public.vendor_alias (
  id bigint generated always as identity primary key,
  vendor_id bigint not null references public.vendor(id) on delete cascade,
  raw_name text not null unique,
  source text not null check (source in ('import','ocr','manual')),
  created_at timestamptz not null default now()
);
```

Resolution rule on import and on OCR verify: normalize → exact match on `normalized_name` or `vendor_alias.raw_name` → attach. No match → create a new `vendor` with `is_confirmed = false` and record the alias. **Never fuzzy-auto-merge** — merging affects payment routing and stays a human decision. Automatic *clustering detection* is cut to week 2 (§12); the identity that clustering will need is captured from day 2, which is the part that is expensive to retrofit.

### 3.3 Status dimensions

```sql
create table public.entry_status (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  source_system text not null check (source_system in ('departmental','main')),
  sort_order int not null,
  is_terminal boolean not null default false
);
```

**Do not seed this from guesswork.** v1 seeded `subject_to_approval / awaiting_for_approval / received / paid`; the actual file contains `pending`, `sent_main` (Departmental) and `approved` (Main). None of v1's four appear. Seed from observed values, and have the importer **auto-insert any unseen status code** with `sort_order = 999` and raise a low-severity exception, so an unknown status surfaces instead of silently mapping to null. The raw text is preserved on the entry regardless.

**The Hub-owned status is a separate dimension.** `awaiting verification` and `awaiting validation` are set by staff in this portal and pushed back out to the modules. They must never share a table or a column with the imported statuses, or an import will overwrite a decision a human made.

```sql
create table public.hub_status (
  id bigint generated always as identity primary key,
  code text not null unique,
  label text not null,
  sort_order int not null,
  is_exportable boolean not null default true,   -- does this state get pushed back?
  is_terminal boolean not null default false
);
-- seed:
--   1 = not_set             'Not set'               (resting state on import; not exported)
--   2 = awaiting_verification 'Awaiting Verification' (Hub-owned, exported)
--   3 = awaiting_validation   'Awaiting Validation'   (Hub-owned, exported)
-- Add further states as a plain insert — no migration, per the text+CHECK-free lookup design.
```

The exact lifecycle — whether `awaiting_verification` always precedes `awaiting_validation`, what state follows validation, and whether either can be reverted — is open (§13). The table is ordered by `sort_order` and the UI enforces whatever transition rules you confirm; nothing in the schema hard-codes a sequence, so confirming it later is a config change.

### 3.4 `entries` — the unified record

```sql
create table public.entries (
  id bigint generated always as identity primary key,

  -- identity
  type text not null default 'invoice'
    check (type in ('invoice','reimbursement','advance_payment')),
  ubbl_number text not null unique,      -- normalized to text on import; see note below
  main_number text unique,               -- unique enforced: duplicates are a real integrity signal

  -- classification (import-owned)
  department_id bigint references public.department(id),
  budget_head_id bigint references public.budget_head(id),
  invoice_number text,
  vendor_id bigint references public.vendor(id),
  vendor_raw text,                       -- exactly as exported, always preserved
  date date,

  -- money: BOTH sides, per the Main Reconciliation contract
  tenant_amount numeric(14,2),
  main_amount numeric(14,2),
  amount_variance numeric(14,2) generated always as (
    case when tenant_amount is not null and main_amount is not null
         then tenant_amount - main_amount end
  ) stored,
  variance_reason text,                  -- the export's 'Reason' column

  -- status (import-owned, raw always kept)
  tenant_status_id bigint references public.entry_status(id),
  main_status_id bigint references public.entry_status(id),
  tenant_status_raw text,
  main_status_raw text,

  -- Hub enrichment (never touched by import)
  head_id bigint references public.head(id),
  zone_id bigint references public.zone(id),
  hub_reference text,                    -- the 'new' column, until you define it
  enrichment_note text,

  -- Hub-OWNED status: set here, exported outward. Never written by import.
  hub_status_id bigint not null default 1 references public.hub_status(id),
  hub_status_changed_at timestamptz,
  hub_status_changed_by uuid references auth.users(id),
  hub_status_note text,
  hub_status_exported_at timestamptz,    -- null = pending export
  hub_status_export_batch_id bigint references public.status_export_batch(id),

  -- advance settlement
  settles_entry_id bigint references public.entries(id),   -- this invoice settles that advance

  -- lifecycle
  is_void boolean not null default false, -- soft delete only; financial rows are never hard-deleted
  void_reason text,

  -- provenance
  source text not null default 'import' check (source in ('import','manual','api')),
  import_batch_id bigint references public.import_batch(id),
  budget_head_raw text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id)
);

create index entries_date_idx on public.entries (date);
create index entries_dept_bh_idx on public.entries (department_id, budget_head_id);
create index entries_head_idx on public.entries (head_id) where head_id is not null;
create index entries_zone_idx on public.entries (zone_id) where zone_id is not null;
create index entries_vendor_idx on public.entries (vendor_id);
create index entries_tenant_status_idx on public.entries (tenant_status_id, date);
create index entries_main_number_idx on public.entries (main_number) where main_number is not null;
create index entries_invoice_number_idx on public.entries (invoice_number);
create index entries_batch_idx on public.entries (import_batch_id);
create index entries_variance_idx on public.entries (amount_variance)
  where amount_variance is not null and amount_variance <> 0;
create index entries_settles_idx on public.entries (settles_entry_id) where settles_entry_id is not null;
create index entries_hub_status_idx on public.entries (hub_status_id);
-- the export queue: everything set in the Hub that hasn't been pushed out yet
create index entries_pending_export_idx on public.entries (hub_status_changed_at)
  where hub_status_exported_at is null and hub_status_id <> 1;
```

**`ubbl_number` normalization is mandatory, not cosmetic.** The export mixes integers (`202608051`) and strings (`ADP_202608054`). SheetJS/openpyxl return a JS number or Python int for the former; naive `String(v)` on a float yields `"202608051"` on one runtime and `"202608051.0"` on another, which breaks the unique key and duplicates every advance on the second import. The importer runs a single `normalizeId()` — reject non-finite, reject decimals, `String(Math.trunc(n))` for numbers, `.trim()` for strings — and unit-tests it against both shapes before anything else runs.

**Namespace collision check:** because `ADP_202608054` appears as a UBBL on one row and a Main Number on another, the importer asserts after each batch that no value exists in both `ubbl_number` and `main_number` across different rows, and raises a `high` exception if it does. Nothing in the system may join on a bare "number".

### 3.5 Budget allocation

```sql
create table public.budget_allocation (
  id bigint generated always as identity primary key,
  budget_head_id bigint not null references public.budget_head(id),
  import_batch_id bigint not null references public.import_batch(id),
  as_of date not null,
  request_amount numeric(14,2),
  approved_amount numeric(14,2),
  utilised_amount numeric(14,2),         -- as reported by the source
  balance_amount numeric(14,2),
  created_at timestamptz not null default now(),
  unique (budget_head_id, import_batch_id)
);
create index budget_allocation_head_date_idx on public.budget_allocation (budget_head_id, as_of desc);
```

Append-only snapshots. Current position = latest row per head. Burn-over-time comes free from the history, which a single mutable row could not give you.

> **Flag, not a blocker.** In the sample, `Approved Amount = 0` on every head while ₹2,32,46,861 is already utilised against ₹5,00,00,000 requested. Budget-vs-actual will render with a zero denominator until that is resolved. The report handles it — heads with `approved_amount = 0` show *"no approved budget"* rather than −100%. But the number itself is a question for you (§13).

### 3.6 Import

```sql
create table public.import_batch (
  id bigint generated always as identity primary key,
  source_system text not null check (source_system in ('departmental','main')),
  source_filename text not null,
  file_hash_sha256 text not null,
  sheet_name text,
  mode text not null default 'dry_run' check (mode in ('dry_run','commit')),
  row_count int,
  imported_by uuid references auth.users(id),
  status text not null default 'processing'
    check (status in ('processing','completed','completed_with_exceptions','failed')),
  summary_jsonb jsonb,                   -- counts by action, for the preview screen
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text
);

create table public.import_row_log (
  id bigint generated always as identity primary key,
  import_batch_id bigint not null references public.import_batch(id) on delete cascade,
  entry_id bigint references public.entries(id),
  row_number int not null,
  raw_row_jsonb jsonb not null,
  action text not null check (action in
    ('inserted','updated','unchanged','skipped_header','skipped_total',
     'skipped_no_ubbl','new_budget_head','new_vendor','error')),
  fields_changed jsonb,
  created_at timestamptz not null default now()
);
create index import_row_log_batch_idx on public.import_row_log (import_batch_id);
create index import_row_log_entry_idx on public.import_row_log (entry_id);
```

**Dry-run is the default.** Every import runs in `dry_run` first: it parses, resolves, and writes `import_row_log` inside a transaction that is then rolled back, leaving only the batch row and its summary. The operator sees *"14 unchanged, 2 updated (2 fields), 1 new vendor, 1 new budget head"* and a per-row diff before committing. A finance import that applies blind is a defect, not a feature.

**Parsing rules, verified against the real file:**

1. Forward-fill `Budget Head` and `Department` down from head rows onto their entry sub-rows.
2. A row is an **allocation row** when it has an `Srno` and a `Budget Head` → write `budget_allocation`. It may *also* carry the first entry on the same line (row 3 does exactly this) — handle both in one pass.
3. A row is an **entry row** when `UBBL Number` is non-empty. No UBBL → not an entry.
4. Skip the `Grand Total` row — detected by `Department == 'Grand Total'` in **column C**, not column A.
5. Trim `Invoice Number`; null out `NA` and blanks. Note `' quotation'` is a real value — an advance against a quotation, not an invoice number.
6. `type`: `ADP_` prefix → `advance_payment`, else `invoice`. **Refine from Sheet 2's `Type` column** once you send a populated Main export; the prefix heuristic is a placeholder, and the code isolates it in one function.
7. Map `Status` / `Main Status` to `entry_status`; auto-insert unknown codes with an exception; always keep the raw text.
8. Assert `sum(entry tenant_amount) == allocation.utilised_amount` per head. This holds exactly in the sample (Other setup expenses 2,216,011; Dome Tents 14,200,000; Labour 430,850). A mismatch is a `high` exception — it means the export is inconsistent and nothing downstream should be trusted.

**Upsert — Hub-owned columns excluded by construction:**

```sql
insert into public.entries (
  type, ubbl_number, main_number, department_id, budget_head_id, invoice_number,
  vendor_id, vendor_raw, date, tenant_amount, main_amount, variance_reason,
  tenant_status_id, main_status_id, tenant_status_raw, main_status_raw,
  budget_head_raw, source, import_batch_id, updated_at
) values (...)
on conflict (ubbl_number) do update set
  main_number       = coalesce(excluded.main_number, entries.main_number),
  department_id     = excluded.department_id,
  budget_head_id    = excluded.budget_head_id,
  invoice_number    = excluded.invoice_number,
  vendor_id         = excluded.vendor_id,
  vendor_raw        = excluded.vendor_raw,
  date              = excluded.date,
  tenant_amount     = excluded.tenant_amount,
  main_amount       = coalesce(excluded.main_amount, entries.main_amount),
  variance_reason   = coalesce(excluded.variance_reason, entries.variance_reason),
  tenant_status_id  = excluded.tenant_status_id,
  main_status_id    = coalesce(excluded.main_status_id, entries.main_status_id),
  tenant_status_raw = excluded.tenant_status_raw,
  main_status_raw   = coalesce(excluded.main_status_raw, entries.main_status_raw),
  budget_head_raw   = excluded.budget_head_raw,
  import_batch_id   = excluded.import_batch_id,
  updated_at        = now();
-- head_id, zone_id, hub_reference, enrichment_note, settles_entry_id, is_void,
-- hub_status_id, hub_status_changed_at/by, hub_status_note, hub_status_exported_at
-- are deliberately absent. Postgres leaves them untouched. This is the guarantee.
```

The `coalesce` on Main-side columns matters: a Departmental import must never blank a Main value the Main import already supplied.

**The `hub_status_*` exclusion is the most consequential line in that statement.** Those columns hold a decision a human made in this portal, which the modules do not know about until the Hub exports it. If a re-import ever wrote them, a staff member's verification decision would silently revert to the module's stale view. The idempotency test on day 6 asserts this explicitly.

**Both sources, one module.** `import-excel` is parameterized by `source_system`. Departmental's shape is known now; Main's is defined by Sheet 2's header row. The Main mapping is written on day 2 against that contract and wired the day a populated file arrives — a config change, not new architecture.

### 3.7 Status export — the outward path

The two Hub-owned statuses are set here and pushed back to Departmental/Main. This is the one place data flows outward, and it is the reason "push back" is no longer a future-tense pillar.

```sql
create table public.status_export_batch (
  id bigint generated always as identity primary key,
  target_system text not null check (target_system in ('departmental','main','both')),
  format text not null default 'xlsx' check (format in ('xlsx','csv','api')),
  row_count int not null,
  storage_path text,                     -- the generated file, if format <> 'api'
  file_hash_sha256 text,
  status text not null default 'generated'
    check (status in ('generated','delivered','acknowledged','failed')),
  delivered_at timestamptz,
  acknowledged_at timestamptz,           -- set when the module confirms it applied the change
  acknowledged_note text,
  generated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  error_message text
);

create table public.status_export_row (
  id bigint generated always as identity primary key,
  status_export_batch_id bigint not null references public.status_export_batch(id) on delete cascade,
  entry_id bigint not null references public.entries(id),
  ubbl_number text not null,             -- snapshotted: the export must not depend on a later edit
  main_number text,
  hub_status_code text not null,
  hub_status_note text,
  changed_at timestamptz not null,
  changed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (status_export_batch_id, entry_id)
);
create index status_export_row_entry_idx on public.status_export_row (entry_id);
```

**Flow.** An admin opens `/export`, sees every entry whose `hub_status_exported_at is null` and whose status is not `not_set`, reviews the list, and generates a batch. The generator, in one transaction: writes `status_export_batch`, snapshots one `status_export_row` per entry, sets `entries.hub_status_exported_at = now()` and `hub_status_export_batch_id`, and produces an `.xlsx` keyed on **both** `UBBL Number` and `Main Entry Number` — because those two namespaces overlap (§3.4) and the receiving module must be able to match on the one it owns.

**Re-export is explicit, not automatic.** If someone changes a status again after export, `hub_status_exported_at` resets to null and the entry re-enters the queue. The previous `status_export_row` stays as a permanent record of what was sent and when — a delivered export is never rewritten.

**Acknowledgement is tracked but not required.** `status` moves `generated → delivered → acknowledged` manually in week 1, because delivery is a person sending a file. When the API replaces the file (week 2+), the same three states are set programmatically and nothing else changes — which is precisely why the state machine exists now rather than later.

**Week 1 is file-based; the API is week 2.** `format = 'api'` is in the CHECK constraint from day one so switching is a config change. The generator is written as an isolated `entry-fields → module-shape` transform — the mirror of the import transform — so the API version reuses it wholesale.

### 3.8 Documents and extraction

```sql
create table public.staff_profile (
  id uuid primary key references auth.users(id),
  display_name text not null,
  role text not null default 'reviewer' check (role in ('admin','reviewer','viewer')),
  department_id bigint references public.department(id),   -- null = all departments
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- v1 had no way for this row to exist. Without it, every first login fails is_staff() forever.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.staff_profile (id, display_name, role, is_active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email), 'viewer', false)
  on conflict (id) do nothing;
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();
-- New users land inactive with role 'viewer'. An admin activates and assigns.

create table public.source_document (
  id bigint generated always as identity primary key,
  entry_id bigint references public.entries(id),   -- NULLABLE: documents arrive before entries
  storage_bucket text not null default 'invoice-documents',
  storage_path text not null unique,
  original_filename text not null,
  file_hash_sha256 text not null,
  mime_type text not null,
  page_count int,
  upload_status text not null default 'uploaded'
    check (upload_status in ('uploaded','processing','processed','failed')),
  match_status text not null default 'unmatched'
    check (match_status in ('unmatched','suggested','matched','no_entry_expected')),
  claimed_by uuid references auth.users(id),       -- two reviewers can't open the same doc
  claimed_at timestamptz,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now()
);
create index source_document_entry_idx on public.source_document (entry_id);
create index source_document_hash_idx on public.source_document (file_hash_sha256);
create index source_document_inbox_idx on public.source_document (match_status, uploaded_at)
  where match_status in ('unmatched','suggested');

create table public.document_page (
  id bigint generated always as identity primary key,
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  page_number int not null,
  image_storage_path text,                -- NULLABLE and transient: the rasterised PNG is a derived
                                          -- artifact, held only while a run is in flight and cleared
                                          -- on success. Storing all of them triples storage (§6.2);
                                          -- pdf.js re-renders from the PDF for free on demand.
  is_financial_document boolean,          -- renamed: applies to invoices, chits, and receipts alike
  classification_confidence numeric(4,3),
  skip_reason text check (skip_reason in ('bank_cheque','passbook','unrelated_document','blank','other')),
  created_at timestamptz not null default now(),
  unique (source_document_id, page_number)
);

create table public.ocr_extraction_run (
  id bigint generated always as identity primary key,
  source_document_id bigint not null references public.source_document(id) on delete cascade,
  model text not null,
  run_reason text not null check (run_reason in ('initial','auto_escalation','manual_reescalation')),
  triggered_by uuid references auth.users(id),
  api_request_id text,                    -- Batch API custom_id
  status text not null default 'pending' check (status in ('pending','running','succeeded','failed')),
  raw_response_jsonb jsonb,
  legibility text check (legibility in ('clear','partial','poor')),
  extraction_confidence numeric(4,3),
  contains_non_latin_script boolean not null default false,
  input_tokens int, output_tokens int, cost_usd numeric(10,6),   -- cost visible per document
  error_message text,
  started_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index ocr_run_document_idx on public.ocr_extraction_run (source_document_id);
create index ocr_run_pending_idx on public.ocr_extraction_run (created_at) where status = 'pending';

create table public.document_extraction (
  id bigint generated always as identity primary key,
  source_document_id bigint not null unique references public.source_document(id) on delete cascade,
  current_extraction_run_id bigint references public.ocr_extraction_run(id),

  vendor_name_ocr text,            vendor_name_verified text,
  vendor_gstin_ocr text,           vendor_gstin_verified text,       -- needed for clustering
  vendor_phone_ocr text,           vendor_phone_verified text,       -- needed for clustering
  vendor_address_ocr text,         vendor_address_verified text,
  invoice_number_ocr text,         invoice_number_verified text,
  invoice_date_ocr date,           invoice_date_verified date,
  subtotal_ocr numeric(14,2),      subtotal_verified numeric(14,2),
  tax_amount_ocr numeric(14,2),    tax_amount_verified numeric(14,2),
  total_amount_ocr numeric(14,2),  total_amount_verified numeric(14,2),
  notes_ocr text,                  notes_verified text,

  verified_at timestamptz,
  verified_by uuid references auth.users(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index document_extraction_open_idx on public.document_extraction (created_at) where verified_at is null;

create table public.document_extraction_line_item (
  id bigint generated always as identity primary key,
  document_extraction_id bigint not null references public.document_extraction(id) on delete cascade,
  document_page_id bigint references public.document_page(id),
  line_order int not null,

  description_ocr text,           description_verified text,
  hsn_sac_code_ocr text,          hsn_sac_code_verified text,
  quantity_ocr numeric(12,3),     quantity_verified numeric(12,3),
  quantity_raw_text_ocr text,     quantity_raw_text_verified text,   -- e.g. "19+12+7+5+7+5"
  unit_ocr text,                  unit_verified text,
  unit_normalized text,                                              -- sqft/nos/day — set on verify
  list_rate_ocr numeric(14,2),    list_rate_verified numeric(14,2),
  discount_pct_ocr numeric(6,3),  discount_pct_verified numeric(6,3),
  discount_note_ocr text,         discount_note_verified text,
  net_rate_ocr numeric(14,2),     net_rate_verified numeric(14,2),
  line_amount_ocr numeric(14,2),  line_amount_verified numeric(14,2),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index doc_line_item_parent_idx on public.document_extraction_line_item (document_extraction_id);
```

`unit_normalized` is a small controlled vocabulary picked from a dropdown at verify time. Comparing a rate in `sq ft` against one in `sqft` against one in `running feet` produces confident nonsense, and normalising after the fact is far harder than at the point a human is already looking at the line.

### 3.9 Change history

v1 claimed *"the audit trail never trusts a client-supplied value"* while storing only `updated_by` — the **last** writer. An overwrite that records only its most recent author is a silent overwrite, which the original tech spec §6.5 explicitly forbids.

```sql
create table public.entry_change_log (
  id bigint generated always as identity primary key,
  entry_id bigint not null references public.entries(id) on delete cascade,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now(),
  source text not null check (source in ('import','manual','system')),
  changes jsonb not null                -- {field: {from: ..., to: ...}}
);
create index entry_change_log_entry_idx on public.entry_change_log (entry_id, changed_at desc);
```

Written by a `before update` trigger that also forces `updated_at = now()` and `updated_by = auth.uid()` server-side. The same trigger pattern covers `document_extraction` and `document_extraction_line_item`. Client-supplied audit values are never trusted.

**Hub status changes get the same treatment, and matter most.** A change to `hub_status_id` is the one edit in this system that leaves the building. The trigger records the from/to codes, the acting user, and the note; the entry detail screen surfaces the status history as its own timeline, separate from the general field-change list. When a module later asks "who marked this awaiting validation, and when," the answer is one query.

### 3.10 Exceptions, rate reference, flags

```sql
create table public.reconciliation_exception (
  id bigint generated always as identity primary key,
  entry_id bigint references public.entries(id) on delete cascade,
  document_extraction_id bigint references public.document_extraction(id) on delete cascade,
  import_batch_id bigint references public.import_batch(id) on delete cascade,
  exception_type text not null check (exception_type in (
    'line_item_tally_mismatch','ocr_total_vs_tenant_amount','tenant_vs_main_variance',
    'allocation_sum_mismatch','unknown_status_code','id_namespace_collision',
    'duplicate_document_hash','missing_documentation','new_budget_head','new_vendor','other')),
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  amount_at_risk numeric(14,2),
  description text,
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  resolution_note text,
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  dedup_key text unique,
  created_at timestamptz not null default now()
);
create index recon_exception_open_idx on public.reconciliation_exception (status, severity, amount_at_risk desc)
  where status = 'open';

-- Populated from day 4 even though nothing queries it until week 2.
-- Without this, week 2 starts with zero history and the rate reports are empty.
create table public.rate_reference (
  id bigint generated always as identity primary key,
  item_key text,                         -- null until the item catalog lands in week 2
  item_description_raw text not null,
  vendor_id bigint not null references public.vendor(id),
  net_rate numeric(14,2) not null,
  unit_normalized text,
  discount_pct numeric(6,3),
  observed_date date,
  entry_id bigint references public.entries(id),
  line_item_id bigint references public.document_extraction_line_item(id),
  created_at timestamptz not null default now()
);
create index rate_reference_item_vendor_idx on public.rate_reference (item_key, vendor_id);
create index rate_reference_item_date_idx on public.rate_reference (item_key, observed_date desc);

-- Schema only in week 1. The engine is week 2 (§12).
create table public.flags (
  id bigint generated always as identity primary key,
  flag_type text not null check (flag_type in
    ('vendor_cluster','duplicate_payment','rate_drift','discount_inconsistency','missing_documentation')),
  entry_id bigint references public.entries(id),
  related_entry_ids bigint[],
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  description text not null,
  amount_at_risk numeric(14,2),
  dedup_key text not null unique,
  status text not null default 'open' check (status in ('open','confirmed','dismissed')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  detected_by_run text,
  created_at timestamptz not null default now()
);
create index flags_open_idx on public.flags (status, severity, amount_at_risk desc) where status = 'open';
```

---

### 3.11 Job queue

Background work (OCR extraction, Batch API polling, export generation) runs through a plain Postgres queue rather than any host's scheduler. This is what makes the Windows Server move a configuration change instead of a rewrite (§13).

```sql
create table public.job_queue (
  id bigint generated always as identity primary key,
  job_type text not null check (job_type in
    ('extract_document','poll_batch','generate_export','rasterize_retry')),
  payload jsonb not null,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','dead')),
  priority int not null default 100,          -- lower runs first
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),   -- backoff and scheduling
  locked_by text,                                  -- worker instance id
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index job_queue_claim_idx on public.job_queue (status, run_after, priority)
  where status = 'queued';
create index job_queue_stale_idx on public.job_queue (locked_at) where status = 'running';
```

Claiming is a single statement, safe across any number of concurrent workers on any number of machines:

```sql
update public.job_queue
   set status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
 where id = (
   select id from public.job_queue
    where status = 'queued' and run_after <= now()
    order by priority, id
    for update skip locked
    limit 1)
returning *;
```

`FOR UPDATE SKIP LOCKED` is ordinary Postgres — no extension, no Supabase feature, no vendor lock. A job stuck in `running` past a timeout is reclaimed by a sweeper and retried with exponential backoff on `run_after`; after `max_attempts` it goes `dead` and raises an exception row so a human sees it rather than it vanishing.

**One worker loop, two ways to run it.** On Vercel today: a Cron entry calls `/api/jobs/tick` every minute, which drains for ~50 seconds and returns (inside Vercel Pro's function limit). On the Windows Server later: `worker/index.ts` runs continuously as a service, claiming jobs in a loop. **Identical handler code in `lib/jobs/handlers/`** — only the caller differs, which is the whole point of the queue.

---

## 4. Security

### 4.1 Helpers

```sql
create schema if not exists private;

create or replace function private.is_staff() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active);
$$;

create or replace function private.is_admin() returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active and sp.role = 'admin');
$$;

-- null department_id on the profile = access to every department
create or replace function private.can_see_department(dept_id bigint) returns boolean
language sql security definer stable set search_path = '' as $$
  select exists (select 1 from public.staff_profile sp
                 where sp.id = (select auth.uid()) and sp.is_active
                   and (sp.department_id is null or sp.department_id = dept_id));
$$;
```

### 4.2 Table policies

```sql
alter table public.entries enable row level security;
alter table public.entries force row level security;

create policy entries_select on public.entries for select to authenticated
  using ((select private.can_see_department(department_id)));

create policy entries_update on public.entries for update to authenticated
  using ((select private.can_see_department(department_id))
         and (select private.is_staff())
         and exists (select 1 from public.staff_profile sp
                     where sp.id = (select auth.uid()) and sp.role in ('admin','reviewer')))
  with check ((select private.can_see_department(department_id)));

-- No delete policy at all. Financial rows are voided (is_void), never removed.
-- INSERT: none — importers run as service_role and bypass RLS by design.
```

Department scoping is cheap now (one column, one function) and expensive to retrofit once several departments are live. It ships in week 1 even though only Venue Setup exists today.

### 4.3 Storage — the gap v1 left open

Table RLS was written; bucket policies were not. Invoices carry vendor bank details.

```sql
-- Bucket 'invoice-documents' created private. No public URLs, ever.
create policy "staff read documents" on storage.objects for select to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_staff()));

create policy "staff upload documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-documents' and (select private.is_staff()));

-- REQUIRED for re-upload/replace. Storage upsert needs INSERT + SELECT + UPDATE together;
-- with only INSERT, replacing a file fails silently rather than erroring.
create policy "staff replace documents" on storage.objects for update to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_staff()))
  with check (bucket_id = 'invoice-documents' and (select private.is_staff()));

create policy "admins delete documents" on storage.objects for delete to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_admin()));
```

The app serves documents through **short-lived signed URLs (5 minutes)** generated server-side. Nothing renders a raw storage path in the browser.

### 4.4 Reporting views must be `security_invoker`

**A Postgres view bypasses RLS by default** — it runs with the privileges of whoever created it, not whoever queries it. A reporting view over `entries` created the ordinary way would hand every department's spend to every reviewer, silently, no matter how correct the table policies are. Every view in `20260808000028_reporting_views.sql` is created as:

```sql
create view public.v_budget_vs_actual with (security_invoker = true) as
  select ... from public.entries e join public.budget_allocation ba on ...;
```

`security_invoker = true` makes the view run as the calling user, so the underlying RLS policies apply. This is checked explicitly on day 5: query each reporting view as a department-1 reviewer and confirm no department-2 rows appear.

### 4.4b Content Security Policy — required by central IT

CSP is a browser-enforced allowlist: it tells the browser which origins may supply scripts, styles, images, and network calls, and blocks everything else. It is the main defence against cross-site scripting — if an attacker ever injects a `<script>` into a page, CSP stops it running.

**Set it in the application, not at the proxy.** A `proxy.ts` (Next.js 16; `middleware.ts` in 15 and earlier) travels with the code from Vercel to IIS unchanged. Setting it in IIS instead means it does not exist on Vercel, and configuring it in *both* places is worse than either: browsers apply the intersection of duplicate CSP headers, producing breakage that looks like a code bug. **Exactly one layer sets CSP, and it is the app.** Give central IT the header value to audit; do not give them a second place to set it.

**Nonce-based, because `'unsafe-inline'` defeats the purpose.** Each request gets a fresh random nonce; Next.js parses the CSP header and automatically attaches that nonce to its own framework scripts, page bundles, and generated inline styles. No manual tagging.

```ts
// proxy.ts   (Next.js 16 — file is named middleware.ts on 15 and earlier)
import { NextRequest, NextResponse } from 'next/server'

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const isDev = process.env.NODE_ENV === 'development'
  const supabase = process.env.NEXT_PUBLIC_SUPABASE_URL!          // https://<ref>.supabase.co
  const supabaseWs = supabase.replace('https://', 'wss://')

  const csp = `
    default-src 'self';
    script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''};
    style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`};
    img-src 'self' blob: data: ${supabase};
    font-src 'self';
    connect-src 'self' ${supabase} ${supabaseWs} https://*.sentry.io;
    worker-src 'self' blob:;
    object-src 'none';
    base-uri 'self';
    form-action 'self';
    frame-ancestors 'none';
    upgrade-insecure-requests;
  `.replace(/\s{2,}/g, ' ').trim()

  const header = process.env.CSP_REPORT_ONLY === 'true'
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy'

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)   // Next reads the nonce from here

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set(header, csp)
  res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  res.headers.set('X-Content-Type-Options', 'nosniff')
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  return res
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
}
```

`camera=(self)` is deliberate — on-site staff photograph bills from their phones (§5).

**Why each non-obvious directive is there:**

| Directive | Reason |
|---|---|
| `connect-src … supabase.co` + `wss://` | Every Data API call and any Realtime subscription. Omit this and the app loads but nothing fetches. |
| `img-src blob: data:` | **pdf.js renders pages to a canvas and hands back blob/data URLs.** Without this the document viewer is blank. |
| `img-src … supabase.co` | Signed Storage URLs for original documents. |
| `worker-src 'self' blob:` | **pdf.js runs its parser in a Web Worker.** Without this, PDF rendering fails silently. |
| `frame-ancestors 'none'` | Clickjacking. Supersedes `X-Frame-Options`. |

**Two pdf.js rules that keep the policy strict:**

1. **Self-host the pdf.js worker.** Put `pdf.worker.min.mjs` in `/public` and point `workerSrc` at the same-origin path. Loading it from a CDN would force a third-party origin into `script-src` and `worker-src` — central IT will reject that, and rightly.
2. **Set `isEvalSupported: false`** when initialising pdf.js. It otherwise uses `eval` for some font handling, which would force `'unsafe-eval'` into production `script-src` and gut the policy. If PDF rendering breaks under CSP, this and `worker-src` are the two causes.

**Roll it out report-only first.** Ship with `CSP_REPORT_ONLY=true`: the browser reports what *would* have been blocked without breaking anything. Watch the console and Sentry for a few days of real use — especially the review screen and the document viewer — then flip to enforcing. Turning on a strict CSP blind, on a deadline, is how you lose a day to a blank PDF pane.

**Known cost, and it is fine here.** Nonce-based CSP requires **dynamic rendering** — no static optimization, no ISR, no Partial Prerendering. §13.2 already forbids ISR as a correctness mechanism for a financial system, so nothing is lost. It does mean pages render per request; at your user count that is irrelevant.

### 4.4c Roles and permissions

Three roles, set on `staff_profile.role`. `department_id` null means all departments; otherwise the user sees only their own (§4.2).

| Capability | `viewer` | `reviewer` | `admin` |
|---|:--:|:--:|:--:|
| See entries, documents, reports (own department) | ✓ | ✓ | ✓ |
| Export CSV from any list | ✓ | ✓ | ✓ |
| Edit enrichment (`head_id`, `zone_id`, `hub_reference`) | — | ✓ | ✓ |
| Verify document extractions | — | ✓ | ✓ |
| Set Hub status (awaiting verification / validation) | — | ✓ | ✓ |
| Resolve or dismiss exceptions | — | ✓ | ✓ |
| Attach documents to entries / manage the inbox | — | ✓ | ✓ |
| Run an import (dry-run **or** commit) | — | — | ✓ |
| Generate a status export batch | — | — | ✓ |
| Void an entry | — | — | ✓ |
| Manage users, roles, department assignment | — | — | ✓ |
| Map budget heads → heads; merge vendors | — | — | ✓ |
| See all departments | — | — | ✓ |

**New users land as `viewer` with `is_active = false`** (the `handle_new_user` trigger, §3.8). An admin activates and assigns. Nobody self-serves into access — deliberate, because this is financial data.

`viewer` exists for the finance head and auditors who need to read everything and change nothing. It is enforced in RLS, not just hidden in the UI: `entries_update` requires `role in ('admin','reviewer')`.

### 4.4d Data retention

| Data | Retention | Why |
|---|---|---|
| Original PDFs / photographs | **Indefinite** | The source of truth if a structured field is ever disputed. Never deleted, only voided at the entry level. |
| Rasterised page PNGs | **Transient** — cleared on successful extraction | Derived artifact; regenerated by pdf.js on demand (§6.2) |
| `entry_change_log` | **Indefinite** | It is the audit trail; deleting it defeats its purpose |
| `status_export_batch` / `_row` | **Indefinite** | Proof of what was sent outward, and when |
| `ocr_extraction_run.raw_response_jsonb` | **Indefinite** | Lets you re-parse without re-billing, forever |
| `import_row_log.raw_row_jsonb` | 24 months | Bulky; useful for a season, not for years |
| `job_queue` rows in `succeeded` | 30 days, swept nightly | Operational noise |

Vendor bank details and phone numbers appear inside stored invoices. The bucket is private, access is via 5-minute signed URLs, and `admin` alone can delete — treat it with the same care as the database itself.

### 4.5 Database connections — which door, and why

Supabase exposes the same Postgres database through several doors. Choosing wrongly is either an outage (connection exhaustion on serverless) or a security hole (a privileged key in the browser).

| Door | Where | Who uses it here |
|---|---|---|
| **Data API** (PostgREST over HTTPS) | `https://<ref>.supabase.co/rest/v1/…` via `supabase-js` | **The whole application.** Browser, server components, server actions. Not a Postgres connection at all. |
| **Direct connection** | `db.<ref>.supabase.co:5432`, user `postgres`, IPv6 | Migrations, `seed.sql`, `pg_dump`. From your machine and CI only. |
| **Shared pooler — session mode** | `aws-<region>.pooler.supabase.com:5432`, user `postgres.<ref>`, IPv4 | Fallback for CLI work when your ISP is IPv4-only. |
| **Shared pooler — transaction mode** | `aws-<region>.pooler.supabase.com:6543`, user `postgres.<ref>`, IPv4 | Only if a raw-SQL layer (Drizzle/Prisma) is ever added. Your server is long-lived, so session mode would also work — but transaction mode is the safer default. Requires `prepare: false` — transaction mode does not support prepared statements. |
| **Dedicated pooler** (PgBouncer, paid) | `db.<ref>.supabase.co:6543` | Not needed at this scale. |

**The application never holds a database connection.** `supabase-js` talks HTTPS to PostgREST, which is a proper API endpoint with its own connection pool on Supabase's side. This removes the entire class of connection-management problems rather than solving it — and it means a restart of the web service leaves no orphaned connections behind, which matters on a single box running two Node services.

**Keys — the new naming, and the one that matters:**

| Key | Format | Where it may appear |
|---|---|---|
| **Publishable** | `sb_publishable_…` | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Safe in the browser — it is only useful in combination with RLS. |
| **Secret** | `sb_secret_…` | Machine-level env vars on the Windows Server, read only by Route Handlers and the worker. **Bypasses RLS entirely.** Never `NEXT_PUBLIC_*`, never in the repo, never in the browser. |
| Legacy `anon` / `service_role` | JWT | Deprecated end of 2026. Use publishable/secret from day one and skip the migration. |

**Database password** appears in exactly two places: your local Supabase CLI config and CI secrets. It is never in application code, because application code never opens a connection.

**How authorization actually works here:** the user signs in → Supabase issues a JWT → `supabase-js` sends it with every Data API call → PostgREST sets the Postgres role and `auth.uid()` for that request → the RLS policies in §4.2 filter the rows. **The database is the enforcement point.** A compromised frontend, a leaked publishable key, or a hand-crafted API call still cannot read another department's entries, because the filtering happens after the identity is established, inside Postgres.

Where the importer and OCR functions need to bypass RLS — they operate across all departments by design — they run in Edge Functions with the secret key, server-side, never reachable from a browser.

---

## 5. Screen inventory

v1 described four days of UI in prose with no screens, states, or navigation. Every screen below specifies its empty, loading, error, and permission-denied state — those are not extra, they are most of the work.

| # | Screen | Route | Phase | Purpose | Notes |
|---|---|---|---|---|---|
| 1 | Sign in | `/login` | 1A | Supabase magic-link or email+password | Inactive account → *"Your account is pending activation"*, not a generic auth error |
| 2 | Dashboard | `/` | 1A | Review queue depth, open exceptions by ₹ at risk, budget burn, today's imports | Every tile links to its filtered list |
| 3 | Entries list | `/entries` | 1A | Filter by department / budget head / head / zone / imported status / **Hub status** / export-pending / date range / vendor / has-variance / has-document; keyset paginated | **Bulk Hub-status change with a required note** — the primary way staff set awaiting verification/validation at volume. Column chooser, CSV export, saved filters in URL |
| 4 | Entry detail | `/entries/[id]` | 1A | Import fields read-only with a source badge; enrichment fields editable; **Hub status control with its own history timeline**; linked documents; change history tab | Advance-settlement picker lives here. Status control shows "exported 2026-08-09" or "pending export" |
| 5 | Import | `/import` | 1A | Upload → **dry-run preview with per-row diff** → commit; batch history | The preview is the screen, not a modal |
| 6 | Document inbox | `/documents` | **1B** | Unmatched documents with suggested entry matches; attach, mark "no entry expected", or bulk-attach | **Highest-volume flow.** ~18 of 21 sample documents land here |
| 7 | Review queue | `/review` | **1B** | The throughput screen. Keyboard-first split pane | §7 |
| 8 | Exceptions | `/exceptions` | 1A | Sorted by severity then ₹ at risk; resolve with a note; filter by type | Resolution note is required — "resolved" with no reason is not an audit trail |
| 9 | Reconciliation | `/reconciliation` | 1A | Tenant vs Main variance, unmatched-on-either-side, allocation-sum mismatches | The report the org currently produces by hand |
| 10 | Reports | `/reports` | 1A | Budget vs actual by head; vendor spend; spend by zone; open-issues digest | CSV export on every one |
| 11 | Export | `/export` | 1A | Queue of entries with a Hub status not yet pushed out; review, generate `.xlsx`, download, mark delivered/acknowledged; batch history with per-row detail | The outward path. Admin-only. Re-exports are explicit, prior batches immutable |
| 13 | Accuracy | `/accuracy` | **1B** | Per-field agreement rate (7/30/all days), trend, top correction patterns grouped by normalised diff; CSV export | Admin-only. §9.2. The export is what gets sent for a tuning pass |
| 12 | Admin | `/admin` | 1A | Users and roles; department assignment; budget-head → head mapping; vendor merge; zone/head master; Hub-status lifecycle rules | The merge screen you deferred lives here |

**Navigation:** persistent left rail — Dashboard, Entries, Documents, Review, Exceptions, Reconciliation, Reports, Export (admin), Admin (admin). Command palette (`Cmd/Ctrl-K`) for jump-to-entry by UBBL, Main number, or invoice number. The Export item carries a badge with the pending-export count, because an unexported status decision is work the modules are still waiting on.

**Responsive:** the app is responsive down to phone width; **upload and the document inbox are explicitly designed for phone use.** Staff photograph bills on site. If capture is desktop-only, documents arrive by WhatsApp and you are back to manual. Review and reports are desktop-first — nobody verifies line items on a phone.

**Connectivity:** upload retries with exponential backoff and shows a persistent queue badge when offline. Full offline mode is out of scope; a queued upload that survives a dropped connection is not.

---

## 6. Cost

**Volume confirmed: 5,000 pages maximum for the whole event**, consisting of 1,000–2,000 invoices with 3–4 pages each. Of those, 1–2 pages per invoice are financial documents; the rest (bank statements, cheques, payment slips) are filtered out automatically and never sent to Claude. Effective extraction volume: **3,000–4,000 pages**. Invoices arrive in batches (pre-event, during-event, post-event); that pattern suits the Batch API.

### 6.1 Anthropic API

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| `claude-haiku-4-5` | $1.00 | $5.00 |
| `claude-sonnet-5` | $3.00 | $15.00 (introductory $2/$10 through 2026-08-31) |

Per page: ~1,600–2,300 image tokens + ~800 schema/prompt tokens in, ~900 tokens out.

- Haiku pass ≈ **$0.0035/page** batched (50% discount)
- Sonnet escalation ≈ **$0.0104/page** batched (50% discount)

**Actual workflow: staff do manual corrections for minor issues; selective escalation only when staff clicks "re-run" or admin overrides (Gujarati, major quality issues). No automatic re-processing.**

At 3,000–4,000 financial pages, minimal escalation:

| Path | Batch API |
|---|---|
| Haiku, 3,500 pages | **$12** |
| Sonnet escalation (~5%, manual only) | **$2** |
| Development and prompt iteration | ~$10 |
| Re-runs and overrides | ~$3 |
| **Total** | **~$27** |

**Buy $25 of credit to start; realistic ceiling is $50.** Monitor weekly during Phase 1B; add $25 increments if escalation rate exceeds 20% (indicates Haiku struggling or page quality issues). Phase 1A spends about **$2** (the day-2 spike). Real OCR spend does not begin until Phase 1B, so there is no rush on funding.

### 6.2 Total cost of ownership

| Item | Cost | Note |
|---|---|---|
| Anthropic API | $25–50 one-time | Start $25, add $25 increments as needed. Monitor weekly. §6.4 |
| Supabase **Pro** | $25/month | Free tier pauses after a week of inactivity — mid-event that is an outage. Pro includes daily backups and 100 GB storage. One project for dev + prod. |
| Vercel | FREE | Free tier handles batch-processing portal well. Job queue in Postgres + Batch API keep function duration under control. Upgrade to Pro ($20/month) only if build/bandwidth limits are hit. |
| Domain | ~$15/year | Already have one; update DNS later. |
| **Running total** | **$25/month for Supabase + incremental Anthropic** | Over a 6-month project: Supabase $150 + Anthropic $50 + Domain $15 = **~$215 all-in**. Supabase Pro is the only permanent recurring cost. |

**Storage is the hidden line item, and it is avoidable.** 10,000 rasterised PNGs at ~250 KB each is 2.5 GB — nearly three times the PDFs themselves. **Do not store the PNGs.** They are a derived artifact needed only during extraction: rasterise in the browser, send to the API, discard. When a reviewer opens a document, pdf.js re-renders the page locally for free. That drops storage from ~3.4 GB to ~0.9 GB and removes a whole class of cleanup work later. `document_page.image_storage_path` therefore becomes nullable — populated only while a run is in flight, cleared on success.

### 6.3 The cost levers you're already using

The workflow you described already captures the biggest savings:

1. **Batch API for everything.** ✓ You're doing this. 50% off, async, perfect for batches. **Already worth ~$35+ savings on this volume.**
2. **Staff do manual corrections instead of automatic re-processing.** ✓ You're doing this. Minor mismatches, low-confidence fields, Gujarati — fixed by hand, not re-escalated. **Saves ~$15 per lifecycle.**
3. **One API call per document, not per page.** ✓ Already in §8.
4. **Classification gate filters non-financial pages.** ✓ Already in §8. Cheques, bank statements never reach Claude.
5. **Never re-call to re-parse.** ✓ Store `raw_response_jsonb`; interpretation is free. Use the button to re-run only when needed.

**Remaining levers to consider (not blockers):**

6. **Tune image resolution.** Dropping long edge from 1,568 px to 1,100 px cuts input tokens ~30–40%. Benchmark against `gold.json` — if accuracy holds, you save a few dollars. Not urgent at $25–50 budget.
7. **Cap `max_tokens` at 2,000.** Already done in §8.
8. **Spend limit at $50.** Already done in §6.4. You cannot overspend more than that without manual approval.
9. **Skip prompt caching.** Not worth it at 3,000–4,000 pages. Move on.

Per-run cost is written to `ocr_extraction_run.cost_usd`, so spend is a SQL query rather than an estimate, and a runaway is visible the same day rather than at the end of the month.

### 6.4 Getting the API key — step by step

1. Go to **console.anthropic.com** and create an organisation account (separate from any Claude.ai subscription — a Claude Pro/Max plan does **not** include API credit; they are billed separately).
2. **Settings → Billing → Add credit.** Start with **$25**. Credits are prepaid; there is no monthly commitment and nothing to cancel. Add $25 increments as you monitor Phase 1B escalation rates.
3. **Settings → Billing → Spend limits → Set limit → $50.** Do this before writing any code. You can raise it later if needed, but start conservative.
4. **Settings → API Keys → Create Key.** Name it `istifada-hub`. Copy it once — it is never shown again.
5. Store the key **only** in Supabase secrets (`supabase secrets set ANTHROPIC_API_KEY=...`). Never in the repo, never in a `NEXT_PUBLIC_*` variable, never in the browser. Single key is fine; you're using one Supabase project for dev + prod.

**Rate limits are not a constraint at this volume.** New organisations start on the **Start** tier: 1,000 requests/minute and 2,000,000 input tokens/minute on Haiku 4.5, with a $500 monthly spend cap. Processing all 10,000 pages at once would take roughly ten minutes of wall-clock at that ceiling. A brand-new organisation may begin on a lower **Evaluation** tier while account history builds — that resolves automatically, and the Batch API is unaffected by it either way (its own limit is 200,000 queued requests on Start tier).

---

## 7. The review queue — the only screen that determines whether this works

Throughput per reviewer is the product's real KPI. Here is the arithmetic:

| Entries | 3 min/verify | 8 min/verify |
|---|---|---|
| 3,000 | 150 h | 400 h |
| 10,000 | 500 h | 1,333 h |

Three reviewers × 5 productive hours/day × 45 days = **675 hours**. At 3 minutes the queue drains comfortably at either volume. At 8 minutes — a mouse-driven form with tab-order accidents — 10,000 entries is 1,333 hours and the queue *grows* through the entire event. The difference between those two columns is entirely interaction design, which is why this gets its own section.

**Layout:** split pane. Page image left (zoom, rotate, page thumbnails), extraction form right, live tally footer.

**Keyboard contract — no mouse required for the common path:**

| Key | Action |
|---|---|
| `Tab` / `Shift-Tab` | Next / previous field |
| `Enter` | Accept the OCR value as verified and advance |
| `Cmd/Ctrl-Enter` | Accept **all** remaining unedited fields and save |
| `J` / `K` | Next / previous document (outside a text field) |
| `E` | Flag as exception, with a note |
| `R` | Re-run extraction (`documents-reescalate`) |
| `1`–`9` | Jump to line item *n* |
| `/` | Focus vendor autocomplete |
| `S` | Set Hub status (`awaiting verification` / `awaiting validation`) with a note |
| `?` | Keyboard shortcut overlay |

**Field affordances:** each field shows the OCR value pre-filled with a confidence tint (green ≥0.9, amber 0.7–0.9, red <0.7). Untouched = accepted on save. Edited fields write only to `_verified` columns; `_ocr` is never mutated. `verified_at` / `verified_by` are set server-side by trigger.

**Live tally footer**, recomputed on every keystroke, showing three numbers side by side:

```
Line items  ₹ 2,21,600   Document total  ₹ 2,21,600  ✓
Entry (tenant) ₹ 2,21,601  ·  variance ₹ 1  ·  within tolerance
```

Tolerance: ±₹1 or 0.05%, whichever is larger. Rounding adjustments are real — one sample invoice carries a `-0.11` line.

**Queue order:** open exception severity ↓ → extraction confidence ↑ → tenant amount ↓. Highest-risk, least-certain, most-material first.

**Concurrency:** opening a document sets `claimed_by` / `claimed_at`. Claims expire after 15 minutes of inactivity. Another reviewer sees *"Being reviewed by Fatema — take over?"* rather than silently overwriting.

**On save,** the same transaction writes `rate_reference` rows from the verified line items. The rate reports are week 2, but their history starts accumulating on day 4 — otherwise week 2 opens with an empty table.

**Hub status is set here too, and this is the point of the whole queue.** Verifying a document is what earns the right to move an entry to `awaiting validation`; the review screen is therefore where most status changes originate. Setting a status queues the entry for export automatically — the reviewer does nothing extra, and the admin sees the count rise on `/export`. If your lifecycle turns out to require verification before validation (§13), the `S` menu enforces it by hiding illegal transitions rather than rejecting them after the fact.

---

## 8. OCR pipeline

1. **Upload (browser).** pdf.js rasterises client-side to PNG at 200 DPI, capped at 1,568 px on the long edge for the Haiku pass. Progress bar per page.
2. **`documents-ingest`.** Creates `source_document`, computes `file_hash_sha256`, writes one `document_page` per PNG. A hash collision raises a `duplicate_document_hash` exception — a soft warning, not a hard block; the same bill legitimately gets re-scanned.
3. **`documents-extract`.** **One `claude-haiku-4-5` call per document, not per page** — all pages as image blocks in a single request. This pays the ~800-token prompt once instead of once per page, and it lets a line-item table that spans a page break extract correctly, which per-page calls cannot do. Single shared tool schema with **`strict: true`**, so the response is guaranteed to validate rather than merely usually validating. Returns a per-page `pages[]` array (`page_number`, `is_financial_document`, `skip_reason`, `classification_confidence`) plus document-level `legibility`, `extraction_confidence`, header fields (including **GSTIN, phone, address** — the fields clustering will need), and `line_items[]` each tagged with its source page. Line items from pages marked `is_financial_document = false` are **hard-filtered in code** before any write, so classification-before-extraction is a real gate rather than a prompt instruction. Cap `max_tokens` at 2,000.
4. **Write** the extraction into `document_extraction` / `_line_item` as `_ocr` columns. `_verified` starts null. Do not automatically re-escalate.
5. **Tally check** immediately on write: line-item sum vs `total_amount_ocr` (epsilon tolerance), and vs `entries.tenant_amount` when the document is matched. Mismatches write `reconciliation_exception` rows. Also flag if legibility is `partial`/`poor` or Gujarati/Devanagari Unicode present (alerting staff to potential re-run).
6. **Staff review** — the review screen shows Haiku's output. Staff accept, correct, or manually override (especially for Gujarati text, quality issues). Minor mismatches and low-confidence fields are corrected by hand, not re-escalated.
7. **`documents-reescalate`** — the manual "re-run with Sonnet" button. Staff clicks when Haiku clearly struggled. Always creates a new run with `run_reason = 'manual_reescalation'`. Sonnet uses higher-resolution rasterisation (2,576 px vs 1,568 px long edge). Prior runs never deleted.
8. **Batch backlog.** Both Haiku and escalated Sonnet runs go through the Batch API; `api_request_id` holds the `custom_id`. **Results arrive in any order — the poller keys by `custom_id`, never by position.**

---

## 9. Measuring extraction accuracy — two mechanisms, different jobs

Two things measure extraction, and they are not substitutes. Using either alone leaves a specific hole.

| | **Gold set** (§9.1) | **Correction log** (§9.3) |
|---|---|---|
| What it is | 21 invoices labelled *before* anyone sees model output | Every `_ocr` ≠ `_verified` delta from real review |
| Answers | "Did my prompt change break anything?" | "What is actually going wrong, at scale?" |
| Feedback speed | **90 seconds** | Days — as invoices arrive |
| Sample | Fixed, 21 | Growing, eventually thousands |
| Bias | None — labelled blind | **Anchored** — see §9.3 |
| Catches silent misses | Yes | **No** |
| Enables A/B of a prompt | **Yes** | No — every measurement is on different documents |
| Cost | ~70 min, once | ~free, forever |

The gold set is a **regression harness**. The correction log is a **discovery mechanism**. The log finds failure classes nobody would think to write test cases for; the gold set is what lets me fix them without breaking something else. **The log feeds the gold set** — when the log shows a pattern, representative invoices get added to `gold.json` and the harness grows to cover real failure modes rather than imagined ones.

### 9.1 Gold set — the regression harness

v1's exit criterion was *"correct extraction on all 21 samples,"* judged by eye. That is not a criterion.

**Prerequisite (yours, ~70 minutes, before day 1 ends).** Two passes, deliberately:

- **10 invoices from scratch (~50 min).** Read the PDF, type the values, never look at model output first. These ten are the trustworthy core — labelled blind, so they measure honestly.
- **11 by correction (~20 min).** I run extraction once and export a pre-filled sheet; you fix what is wrong. Faster, but anchored — you will accept a wrong value more often than you would type it. Fine for eleven documents under focused attention; **not** fine as the whole set, which is why the first ten exist.

Check every `total_amount` against the PDF's own arithmetic independently. It carries the most weight below, and it is the field anchoring damages most.

`npm run score` runs the pipeline against all 21 and prints a per-field table. **90 seconds, deterministic, identical documents every run** — the only way to tell whether a prompt change helped, hurt, or did nothing.

| Metric | Bar to ship |
|---|---|
| `total_amount` exact match | ≥ 98% (20/21) |
| `invoice_number` exact match (after trim) | ≥ 90% |
| `vendor_name` fuzzy match ≥ 0.9 | ≥ 90% |
| Line-item **count** exact | ≥ 90% |
| Line `amount` exact, on matched lines | ≥ 95% |
| Non-financial pages classified `false` | 100% — a cheque page leaking into extraction is a correctness bug, not a quality one |
| Gujarati document escalates to Sonnet | 100% |

Miss a bar → tune the prompt and re-score. The harness is the day-1 deliverable, not an afterthought; it is also what makes any future model change a 90-second decision.

### 9.2 Correction log — the discovery mechanism

**Nearly free, because the schema already produces it.** Every extraction stores `_ocr` and `_verified` side by side (§3.8) and never overwrites the former, so the correction log is a view rather than a new pipeline:

```sql
create view public.v_extraction_correction with (security_invoker = true) as
select de.id, de.source_document_id, r.model, r.run_reason,
       de.verified_at, de.verified_by, f.field, f.ocr_value, f.verified_value
  from public.document_extraction de
  join public.ocr_extraction_run r on r.id = de.current_extraction_run_id
 cross join lateral (values
       ('vendor_name',    de.vendor_name_ocr,        de.vendor_name_verified),
       ('invoice_number', de.invoice_number_ocr,     de.invoice_number_verified),
       ('invoice_date',   de.invoice_date_ocr::text, de.invoice_date_verified::text),
       ('subtotal',       de.subtotal_ocr::text,     de.subtotal_verified::text),
       ('tax_amount',     de.tax_amount_ocr::text,   de.tax_amount_verified::text),
       ('total_amount',   de.total_amount_ocr::text, de.total_amount_verified::text),
       ('vendor_gstin',   de.vendor_gstin_ocr,       de.vendor_gstin_verified)
     ) as f(field, ocr_value, verified_value)
 where de.verified_at is not null
   and f.ocr_value is distinct from f.verified_value;
```

Plus the same shape over `document_extraction_line_item`, and a `line_count` comparison of extracted vs verified item counts — the field where silent misses hide.

**Screen 13 — `/accuracy`** (admin): agreement rate per field over 7/30/all days, trend line, and top correction patterns grouped by normalised diff, so `"Acm" → "Acme Corp"` clusters with other truncations. Exportable — that export is what you send me to act on.

**What this gives you that the gold set cannot:** failure classes nobody would write a test for. *"Vendor name truncated when a logo overlaps the header."* *"Tax line picking up freight."* *"Line items lost after a page break on landscape scans."* With 21 samples I will never see those; across 500 real invoices they are obvious.

**What it cannot do — the reason the gold set stays:**

1. **Anchoring makes it optimistic.** A reviewer shown `"Acm"` in a pre-filled field accepts it far more often than they would type `"Acm"` unprompted. When they accept, the log records *agreement* — a wrong extraction scored correct. Measured accuracy drifts above true accuracy, and the gap widens as reviewers get faster.
2. **It cannot see what was never extracted.** Nine line items, seven extracted, reviewer doesn't notice: `_verified` equals `_ocr`, log says perfect. The tally check catches many of these — which is exactly why it exists — but not a zero-value line, and not a missing line when the total was misread consistently too.
3. **It cannot A/B a prompt.** The decisive one. Change the prompt on day 3 and the next twenty invoices are *different documents*. Accuracy moving 91% → 94% tells you nothing; the invoices may simply have been cleaner. **Comparing two prompts requires holding the documents fixed.** That is arithmetic, not preference.
4. **It is circular.** Tuning on data the model itself produced drifts toward self-agreement rather than correctness.

**How they compound:** the log surfaces a pattern → representative invoices are added to `gold.json` → the harness regression-tests that failure mode forever. The gold set starts at 21 and grows to cover what actually goes wrong, instead of what was imaginable on day 0.

### 9.3 The improvement loop, described honestly

There is **no automatic learning.** The model is not fine-tuned by corrections; the next invoice is not better because the last was fixed. The real cycle is:

```
corrections accumulate  →  read /accuracy  →  prompt or schema change
                        →  re-run gold set (90s — catch regressions)
                        →  deploy  →  measure on the next batch
```

Cadence is **days, not documents** — realistically a tuning pass every few days during the event, an hour or two each. Worth setting that expectation now: if you expect per-invoice improvement, a flat week reads as failure when it is just the loop's natural period.

**Closing the loop automatically is a good Phase 2 addition.** Auto-select three to five previously-corrected examples resembling the current invoice and inject them as few-shot context. That *is* learning without fine-tuning, and it removes me from the cycle. Deferred because it needs a corpus to draw from, and because unvalidated few-shot selection can make accuracy *worse* — which you would only detect with a fixed gold set.

---

### 9.4 Everything else that gets tested

The accuracy harness covers OCR. These cover the parts where a silent bug is worse than a crash — money, identity, and idempotency. **Vitest**, run in CI on every push.

**Unit — pure functions, no database:**

| Target | Cases that must pass |
|---|---|
| `normalizeId` | Integer `202608051` and string `'ADP_202608054'` produce the same result on both runtimes; floats rejected; whitespace trimmed. *This is the function that duplicates every advance payment if it drifts.* |
| `normalizeVendorName` | `'Al Nafees Tech'` / `'AL NAFEES TECH.'` / `'Al  Nafees  Tech'` collapse to one key; `'Poonam Ajay kumar Sharma (Poonam Devi Sharma)'` is stable |
| `normalizeUnit` | `sqft` / `sq ft` / `SQ.FT.` → one value |
| `module-mapping` | Round-trip: entry-fields → module shape → entry-fields is lossless for the two Hub statuses |
| Tally epsilon | `2216011.00` vs `2216010.89` passes; `2216011` vs `2216111` fails |

**Fixture — the real Excel file, committed to `test/fixtures/`:**

- 16 entry rows and 10 allocation rows extracted; nothing else
- The five zero-spend heads (AVIT, Security, Tazyeen, Power, Office setup) **are** kept as allocations — the v1 bug that would have dropped ₹2.5 crore
- `Grand Total` skipped by column C, not column A
- Forward-fill puts rows 4–5 under `Dome Tents`
- Per head, `sum(entry tenant_amount) == allocation.utilised_amount`
- No value appears in both the UBBL and Main-number namespaces

**Integration — against a throwaway Supabase branch:**

- **Idempotency:** import → set `zone_id`, `hub_reference`, `hub_status_id`, and a `_verified` value → import again → assert *only* `updated_at` changed. This is the single most important test in the suite.
- **Dry-run:** produces a row log and leaves `entries` untouched.
- **Queue:** two workers claiming concurrently never take the same job (`SKIP LOCKED`).

**RLS — plain SQL, run as three different users:**

- A department-1 `reviewer` sees zero department-2 rows in `entries` **and in every reporting view** (the `security_invoker` trap, §4.4)
- A `viewer` gets 0 rows updated on an UPDATE — not an error, silently nothing, which is why it must be asserted
- A `reviewer` cannot delete
- `updated_by` always equals the acting user, never a client-supplied value
- `supabase db advisors` reports clean

**Not doing in week 1:** browser end-to-end tests. Playwright on the review-save path is a week-2 addition — valuable, but not at the cost of a day now.

## 10. Migration and file layout

```
supabase/
  migrations/
    20260808000001_extensions.sql
    20260808000002_private_schema_and_helpers.sql
    20260808000003_staff_profile_and_auth_trigger.sql
    20260808000004_department.sql
    20260808000005_head.sql
    20260808000006_zone.sql
    20260808000007_budget_head.sql
    20260808000008_vendor_and_alias.sql
    20260808000009_entry_status.sql
    20260808000010_hub_status.sql
    20260808000011_import_batch_and_row_log.sql
    20260808000012_status_export_batch.sql        -- before entries: entries FKs to it
    20260808000013_entries.sql
    20260808000014_entries_indexes.sql
    20260808000015_status_export_row.sql          -- after entries: it FKs to entries
    20260808000016_budget_allocation.sql
    20260808000017_entry_change_log_and_triggers.sql
    20260808000018_source_document.sql
    20260808000019_document_page.sql
    20260808000020_ocr_extraction_run.sql
    20260808000021_document_extraction.sql
    20260808000022_document_extraction_line_item.sql
    20260808000023_reconciliation_exception.sql
    20260808000024_rate_reference.sql
    20260808000025_flags.sql
    20260808000026_rls_policies.sql
    20260808000027_storage_policies.sql
    20260808000028_reporting_views.sql
  seed.sql                        -- department, 42 heads, 13 zones, entry_status, hub_status
app/                              -- Next.js 15 App Router; screens per §5
  api/                            -- Route Handlers. Plain Node. Move to any host unchanged.
    import/route.ts               -- parameterized by source_system; dry_run | commit
    export-status/route.ts        -- the outward path: entry-fields -> module shape -> .xlsx
    documents/ingest/route.ts
    documents/reescalate/route.ts
    jobs/tick/route.ts            -- drains the queue; Vercel Cron calls it now, worker/ replaces it later
lib/                              -- ZERO framework or host coupling. Pure TypeScript.
  claude-client.ts                -- SDK wrapper, model constants, batch helpers, cost accounting
  extraction-schema.ts            -- the strict tool schema, single source of truth
  normalize.ts                    -- normalizeId, normalizeVendorName, normalizeUnit
  module-mapping.ts               -- raw-row <-> entry-fields, both directions; import and export share it
  storage.ts                      -- thin adapter: put/get/signUrl. Supabase Storage today, disk or S3 later.
  jobs/
    queue.ts                      -- claim/complete/fail against the job_queue table
    handlers/extract.ts           -- one document -> Claude -> extraction rows
    handlers/batch-poll.ts        -- matches Batch API results by custom_id
worker/
  index.ts                        -- standalone Node process: loop { claim job; run handler }
                                  -- unused on Vercel; becomes Windows Service `istifada-hub-worker`
.gitattributes                    -- see §13: CRLF conversion silently breaks file hashes
test/
  gold.json                       -- hand-labelled ground truth for the 21 invoices
  score.ts                        -- accuracy harness
  fixtures/                       -- Excel parse fixtures incl. the grouped-export edge cases
```

---

### 10.2 The reporting views

All eight are created `with (security_invoker = true)` (§4.4) in `20260808000028_reporting_views.sql`. Every screen in §5 reads from these rather than assembling joins in the app, so a filter fix lands in one place.

| View | Feeds | Shape |
|---|---|---|
| `v_entry_enriched` | Everything below, plus the entries list | `entries` + department, budget head, head, zone, vendor, both statuses, hub status, document count. The one join every other view builds on. |
| `v_budget_vs_actual` | Reports, dashboard | Per budget head: latest allocation vs `sum(tenant_amount)`. **Returns `'no approved budget'` rather than −100% when `approved_amount = 0`** (§3.5). |
| `v_vendor_spend` | Reports | Per vendor: entry count, total, first/last date, document coverage % |
| `v_zone_spend` | Reports | Per zone: total and entry count. Null zone reported as *"unassigned"* so gaps in enrichment are visible rather than invisible. |
| `v_tenant_main_variance` | Reconciliation screen | Entries where `amount_variance <> 0`, or present on one side only, with `variance_reason` |
| `v_hub_status_ageing` | Dashboard, reports | Days each entry has sat in `awaiting verification` / `awaiting validation`, bucketed 0–2 / 3–7 / 8+. Answers "what are the modules waiting on?" |
| `v_open_issues` | Exceptions screen, digest | `reconciliation_exception` ∪ `flags`, ordered by severity then ₹ at risk |
| `v_review_queue` | Review screen | Unverified extractions ordered by exception severity ↓, confidence ↑, amount ↓ (§7) |

## 11. Phase 0 — before Phase 1A day 1 (yours, about 40 minutes)

Items 2–5 gate Phase 1A day 1. Item 1 now gates **Phase 1B**, not 1A — the portal-first sequencing buys you roughly two weeks on it. None of these are my work.

| # | Task | Time | Blocks |
|---|---|---|---|
| 1 | **Label the 21 invoices into `test/gold.json`** — 10 from scratch, 11 by correcting a pre-filled sheet (§9.1) | ~70 min | **Phase 1B day 5 — not 1A.** You have ~2 weeks. Still the only thing that can tell you whether a prompt change helped or hurt. |
| 2 | Anthropic Console: org, **$25 credit**, **$50 spend limit** (§6.4) | 10 min | 1A day 2 (the spike); add $25 increments as needed during Phase 1B |
| 3 | One Supabase project with **Pro plan**, publishable + secret keys generated (§6.2) | 10 min | 1A day 1 |
| 4 | Vercel project connected to the repo (free tier), custom domain has one already; update DNS later | 5 min | 1A day 7 |
| 5 | **Rotate the Supabase secret key** if it was ever committed or given a `NEXT_PUBLIC_` prefix | 1 min | Immediately |
| 6 | Answer: **Hub-status lifecycle** — does verification always precede validation? What follows validation? Can either be reverted? | — | 1A day 4 |
| 7 | Confirm: is `Approved Amount = 0` real, or is the export pre-approval? | — | 1A day 6 reports |

Item 6 gates 1A day 4; item 7 gates 1A day 6. Everything else can proceed under a stated assumption, which I will write down rather than leave implicit.

### 11.1 Phase 1A — the portal, day by day (7 days, hard)

**Sequencing decided: the portal first, verification second.** Phase 1A is the financial hub without OCR — it unifies both source systems, enriches, reconciles, reports, and pushes the two Hub statuses back out. That is four of the five pillars, and it is genuinely useful standing alone: staff stop reconciling in Excel from the day it ships, whether or not a single invoice has been scanned.

Each day has an exit criterion that is a command you can run or a row you can see, not a feeling.

**Day 1 — Foundations.** Supabase projects (`dev`, `prod`, Pro on prod), every migration in §10, seed (1 department, 42 heads, 13 zones, observed `entry_status`, 3 `hub_status`). The portability kit up front: `lib/env.ts`, the ESLint host-coupling guard, `output: 'standalone'`, `.gitattributes`. Repo connected to Vercel.
**Exit:** `supabase db push` runs clean on both projects, all seed rows present, and `npm run build` **fails** if someone adds `import { put } from '@vercel/blob'`.

**Day 2 — Import, and the OCR de-risk spike.** `normalizeId` with unit tests against both the integer and `ADP_` string forms. The grouped-Excel parser: forward-fill, allocation rows, budget-head auto-create, vendor resolution, dry-run/commit, and the four assertions (allocation-sum, namespace collision, unknown status, Grand-Total in column C).
**Also today, timeboxed to half a day: the OCR spike — CLI only, no UI, no schema.** Run `documents-extract` against all 21 PDFs and eyeball the JSON. This is not the accuracy harness (§9.1) and produces no score; it exists to answer one question early: *does extraction basically work on these documents?* If pdf.js chokes, if Gujarati returns garbage, if cheque pages leak into line items — I want that on day 2, not in Phase 1B. Cost: about $2.
**Exit:** dry-run previews 16 entry rows + 10 allocations + 1 new budget-head set; commit produces exactly that; an immediate second run reports 16 unchanged. Separately: 21 JSON payloads exist and are recognisably correct, with any surprises written down.

**Day 3 — App shell, auth, entries list.** Next.js scaffold, `@supabase/ssr`, login, the `handle_new_user` trigger, RLS verified from the app. Entries list: filters (department, budget head, head, zone, both statuses, Hub status, date, vendor, has-variance), keyset pagination, column chooser, CSV export.
**Exit:** log in as a reviewer, filter to a budget head, export the CSV, and confirm a second user in another department sees zero of those rows.

**Day 4 — Entry detail, enrichment, Hub status.** Detail screen with import fields read-only and source-badged; `head_id` / `zone_id` / `hub_reference` editable; Hub-status control with its own history timeline; bulk status change with required note on the list; change-history tab.
**Exit:** set a zone and a Hub status on one entry, both appear in `entry_change_log`, and the status change appears on its own timeline with the acting user.

**Day 5 — Status export + exceptions.** `export-status` route and the `/export` screen: pending queue, batch generation, `.xlsx` keyed on **both** UBBL and Main number, delivered/acknowledged tracking, immutable batch history. Exceptions queue sorted by severity then ₹ at risk, with mandatory resolution notes.
**Exit:** set three entries to `awaiting validation`, generate a batch, open the `.xlsx` and confirm both key columns; the three leave the pending queue; changing one again puts it back; the prior batch is untouched.

**Day 6 — Reconciliation, reports, CSP.** All eight views from §10.2, `security_invoker` on every one. Reconciliation screen (tenant vs main variance, unmatched either side, allocation mismatches). Reports: budget vs actual (handling `approved_amount = 0`), vendor spend, zone spend, Hub-status ageing, open issues — CSV on each. CSP shipped **report-only**.
**Exit:** a department-1 reviewer sees zero department-2 rows **in every view**, not just every table. No CSP violations in the console on any 1A screen.

**Day 7 — Deploy, harden, real-data run, buffer.** Deploy to Vercel on your domain. Full run on real data: import, enrich, set statuses, export, re-import for idempotency. RLS suite as three users. `supabase db advisors` clean. Backup restored into `dev`. Sentry + uptime check live. Operator runbook for the 1A workflows. Bug-fix buffer — no new features.
**Exit:** every box in §15.1 ticked.

---

### 11.2 Phase 1B — verification and review (~5 days)

Starts after 1A ships. This is Pillar 2: documents, extraction, the review queue, and the improvement loop. **`test/gold.json` is needed before day 5 of this phase — not before Phase 1A** (§11).

**Day 1 — Storage, upload, ingest.** Bucket + the four storage policies (§4.3), client-side pdf.js rasterisation, `documents-ingest`, `source_document` / `document_page`. Signed-URL serving.
**Exit:** upload a real multi-page PDF from a phone browser; pages appear; the original is retrievable only through a signed URL.

**Day 2 — Extraction pipeline.** Job queue worker, `documents-extract` (one call per document, strict tool schema), classification gate, escalation routing to Sonnet, Batch API path, per-run cost accounting, tally checks writing exceptions.
**Exit:** 21 sample documents extract through the queue; `ocr_extraction_run.cost_usd` populated; the Gujarati document escalates; cheque pages produce no line items.

**Day 3 — Document inbox and matching.** The inbox screen, suggested matches on vendor + amount + date proximity, attach, bulk attach, "no entry expected". **~18 of the 21 samples have no matching entry — this screen is where they live.**
**Exit:** attach a document to an entry from the inbox; the unmatched count falls; a document with genuinely no entry can be parked without pretending otherwise.

**Day 4 — Review queue.** The §7 keyboard contract in full: split pane, confidence tints, live three-way tally, vendor autocomplete, claim/lock, re-extract. Saves write only `_verified` and emit `rate_reference` rows in the same transaction.
**Exit:** verify five real documents without touching the mouse; median under 3 minutes; `rate_reference` has rows.

**Day 5 — Correction log, accuracy, scoring.** `v_extraction_correction` and the `/accuracy` screen (§9.2). `npm run score` against `gold.json`; tune the prompt until every bar in §9.1 is met, re-scoring after each change.
**Exit:** every box in §15.2 ticked.

## 12. Cut from Phase 1A — stated plainly

Seven days is a hard constraint, so this is what does not make it into the portal. Nothing here is quietly dropped; each has a reason and a place to land.

**Everything in Pillar 2 — document upload, OCR, the review queue, the correction log — is Phase 1B (§11.2), not a cut.** It is sequenced after the portal by decision, not dropped for time.

| Cut | Why | When |
|---|---|---|
| Vendor **clustering detection** engine | Needs history plus confirmed vendor identities. The identity model — the expensive part to retrofit — ships day 2. | Week 2 |
| `flags-run` entirely (duplicate payment, rate drift, discount inconsistency) | Pattern-based; genuinely needs verified line items to accumulate first. Schema ships week 1 so nothing has to change later. | Week 2–3 |
| Item catalog and `item_key` normalization | Cross-vendor rate comparison *is* this algorithm; doing it badly is worse than not doing it. `rate_reference` rows accumulate now with `item_key` null and get keyed retroactively. | Week 2 |
| Main-side import wiring | The mapping is written on day 2 against Sheet 2's contract; it cannot be tested until a populated Main export exists. | The day you send the file |
| Budget-head → head **merge** | Your explicit decision to keep them separate. The nullable FK and the admin screen exist; the mapping is empty. | When you confirm |
| Push-back **as a live API call** | The two Hub-owned statuses **do ship in week 1**, as a reviewed `.xlsx` export (§3.7) — that is the whole outward path, working end to end. What is cut is calling the modules' API directly instead of handing over a file. `format = 'api'` is already in the CHECK constraint and the transform is shared, so the swap is config plus an endpoint. | Week 2–3 |
| Push-back of anything **other than** the two statuses | Nothing else in the Hub is authoritative — every other field is imported. | Not planned |
| Native mobile capture | Responsive web upload covers it. | Not planned |
| Email/WhatsApp digest delivery | Reports are pull, not push, in week 1. | Week 2 |
| Approval and payment recording | Out per your scope decision. | Not planned |

---

## 13. Deployment — Vercel now, your Windows Server next

**Decided:** the Windows Server is the destination, but it is not provisioned yet and will take a while. **Week 1 ships on Vercel.** Supabase cloud stays put in both cases — only the app and worker move.

The server will be **publicly reachable on its own domain**, which matters more than it sounds: it means staff at the venue can upload bills from their phones over mobile data. If it had been internal-only, the on-site document-capture workflow in §5 would have needed redesigning. It doesn't.

### 13.0 The interim is the risk, so guard it mechanically

Deploying to Vercel every day for weeks while *intending* to leave is exactly how host coupling creeps in. Nobody decides to lock themselves in; someone just reaches for `@vercel/blob` one afternoon because it's convenient. Two cheap safeguards, both on day 1:

1. **A lint rule that fails the build** on any `@vercel/*` import, any `runtime = 'edge'` export, and any `process.env.VERCEL` read outside `lib/env.ts`. An ESLint `no-restricted-imports` + `no-restricted-syntax` block, about fifteen lines. This turns §13.2 from a document nobody re-reads into a build error.
2. **Run the worker locally at least once a week** (`npm run worker` against the dev project). If it has quietly stopped working because logic drifted into the Route Handler, you find out in a week rather than on migration day.

The migration cost is roughly **one day if these hold, and about a week if they don't.** That is the entire difference.

### 13.1 The shape of it, once moved

```
        Staff browsers  ──HTTPS 443──▶  IIS (or Caddy)          [your Windows Server]
                                          │ reverse proxy
                                          ▼
                                   Next.js  localhost:3000       ← Windows Service #1
                                   worker   (no port)            ← Windows Service #2
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    ▼ HTTPS                                      ▼ HTTPS
            Supabase cloud                              api.anthropic.com
       (Postgres, Auth, Storage, RLS)                    (Haiku / Sonnet)
```

Both outbound legs are ordinary HTTPS. Nothing listens except IIS on 443.

| Component | Where it runs | Note |
|---|---|---|
| **Anthropic API** | Nowhere — outbound call | Needs outbound 443 to `api.anthropic.com` |
| **pdf.js rasterisation** | The user's browser | No server CPU, no `sharp`, no native binaries — a real advantage on Windows |
| **Supabase** (DB, Auth, Storage, RLS) | Supabase cloud | Your server is just a client. Backups stay Supabase's problem |
| **Next.js app** | Windows Service #1 | `output: 'standalone'` — a self-contained Node bundle |
| **Job worker** | Windows Service #2 | Runs continuously. No cron, no scheduler |

### 13.2 The forbidden list — do not introduce host coupling

Nothing on this list may enter the codebase. Each one is rework later, and none of it buys anything now.

- ❌ **Supabase Edge Functions** for business logic. They are Deno, hosted by Supabase — they cannot run on your server. Route Handlers in `app/api/` instead.
- ❌ `@vercel/*` packages of any kind. Storage goes through `lib/storage.ts`; state goes in Postgres.
- ❌ Edge Runtime (`export const runtime = 'edge'`) — Node runtime only.
- ❌ Vercel Image Optimization / `next/image` with remote loaders on document images — self-hosting that path needs `sharp` and native binaries on Windows. Serve document images directly.
- ❌ ISR / on-demand revalidation as a correctness mechanism. This is a financial system; pages render fresh.
- ❌ Any `process.env.VERCEL*` read, anywhere.

On Vercel, function duration limits are real and the job queue is what keeps you inside them. After the move there is no timeout at all — but the queue stays regardless, because it is also what gives you retries, concurrency control, crash recovery, and visibility into what is running.

### 13.3 Server setup — a half-day, whenever the box lands

Run this the day the server is provisioned, **not** on a deadline. Get a hello-world Next.js live behind HTTPS first and confirm it survives a reboot; only then move the real app across. Doing it in that order means the cutover is a deploy, not a debugging session.

**Reverse proxy is an open question pending IT (§17).** IIS is written below as the safe default. If policy permits **Caddy**, take it — a single binary, a five-line config, automatic HTTPS with automatic renewal. It removes steps 3, 4, and the renewal reminder outright.

1. **Prerequisites, before anything else.** Enable long paths and reboot — otherwise `npm install` fails cryptically later:
   ```powershell
   Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
   ```
   Set the machine timezone to **UTC**. Add an antivirus exclusion for the deploy directory.
2. **Node.** Install the pinned Node LTS. Record the exact version in `.nvmrc` so dev and server never drift.
3. **Reverse proxy.** IIS with **URL Rewrite + Application Request Routing**, forwarding `https://hub.<yourdomain>` → `http://localhost:3000`. *(Do not use `iisnode` — unmaintained.)* **If IIS is not mandated by policy, use Caddy** — it is a single binary with a 5-line config and automatic HTTPS, and will save you most of steps 3 and 4.
4. **Certificate.** The host is publicly reachable on its own domain, so `win-acme` gets you a free Let's Encrypt certificate with a scheduled renewal task. Bind it in IIS. Set a calendar reminder anyway — an expired certificate is the single most common self-hosting outage. *(Caddy does all of this by itself.)*
5. **Services.** Register both processes with **NSSM** (or `node-windows`) so they start on boot and restart on crash:
   - `istifada-hub-web` → `node .next/standalone/server.js`
   - `istifada-hub-worker` → `node worker/index.js`
6. **Environment variables.** Set at machine level or in the NSSM service definition — **not** in a `.env` file inside the web root, where a proxy misconfiguration could serve it.
7. **Firewall.** Inbound: 443 only. Outbound: 443 to `api.anthropic.com` and `*.supabase.co`.
8. **Deploy script.** A short PowerShell script — `git pull` → `npm ci` → `npm run build` → `Restart-Service` on both. Committed to the repo, so deployment is one command and not a memory.

### 13.4 What you take over from Vercel on cutover day

None are blockers, but each is a real task that currently happens invisibly:

| Was automatic | Now yours |
|---|---|
| HTTPS certificate + renewal | `win-acme` scheduled task, or Caddy (automatic) |
| Restart on crash | NSSM service recovery settings |
| Restart on reboot | NSSM auto-start |
| Zero-downtime deploys | Brief restart. Acceptable — deploy outside review hours |
| Preview / branch deploys | A second site on the same box (port 3001) or your dev machine. Worth keeping the Vercel project alive on Hobby purely for previews if that's useful. |
| Uptime monitoring | Sentry catches errors; add an external ping check (UptimeRobot free tier) so a dead service is noticed by someone other than a user |

### 13.5 Windows-specific landmines

Each of these has bitten real projects; none are hypothetical.

- **`MAX_PATH` 260 characters.** Deep `node_modules` nesting exceeds it and `npm install` fails with cryptic errors. Enable long paths **before** the first install: `Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1` and reboot.
- **CRLF line endings silently break file hashes.** This plan uses `file_hash_sha256` for duplicate detection on both imports and documents. If git converts line endings between machines, identical files hash differently and duplicate detection stops working. Ship a `.gitattributes` on day 1:
  ```
  * text=auto eol=lf
  *.xlsx binary
  *.pdf  binary
  *.png  binary
  ```
- **Server timezone.** Set the machine to **UTC**. All timestamps are `timestamptz` so the database is safe, but Excel date parsing during import reads the *process* timezone — a server on IST will shift `26-07-2026` by hours.
- **Case-insensitive filesystem.** `import x from './Button'` and `'./button'` both work on Windows; only one works on Linux. Running on Vercel (Linux) first is an accidental advantage — it will surface every casing bug before the Windows Server ever sees the code. Keep TypeScript's `forceConsistentCasingInFileNames` on so the compiler catches them even after you leave.
- **Antivirus scanning `node_modules`** destroys build times. Exclude the deploy directory.
- **Backups stay Supabase's.** Because the database is not moving, daily backups and point-in-time recovery remain managed. What is now *yours* is the application server: keep the deploy directory in git and treat the box as rebuildable, so a dead server is a redeploy rather than a recovery.

### 13.6 The database is not moving

Confirmed: **Supabase stays in the cloud.** Only the app and worker move to the Windows Server. That keeps auth, RLS, Storage, daily backups, and point-in-time recovery managed, and it means the cutover touches deployment only — no data migration, no downtime beyond a service restart, and a rollback that is just "point DNS back at Vercel."

Worth stating why this is the right call rather than a deferral: Supabase self-hosted is a Docker Compose stack built for Linux. On Windows Server it runs only under Docker Desktop / WSL2, which is not a foundation for a financial system. If in-house data ever becomes a policy requirement, the honest answer is a Linux VM alongside — a separate project, not a migration step.

### 13.7 The portability kit — five files that make the move a day

Portability is not a principle you remember; it is a small number of files that make the wrong thing hard. Write these in week 1 and the cutover is mechanical.

**1. `lib/env.ts` — the only place environment is read.** Validated once at boot, so a missing variable fails immediately with a clear message instead of surfacing as `undefined` three screens deep. Crucially, `DEPLOY_TARGET` is the *single* permitted host branch in the entire codebase.

```ts
import { z } from 'zod'

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  DEPLOY_TARGET: z.enum(['vercel', 'server']).default('vercel'),
  CSP_REPORT_ONLY: z.enum(['true', 'false']).default('true'),
  WORKER_ID: z.string().default('local'),
})

export const env = schema.parse(process.env)
export const isServerHost = env.DEPLOY_TARGET === 'server'
```

**2. The ESLint block that makes lock-in a build failure.** Fifteen lines; worth more than any amount of documentation, because it fires on the afternoon someone reaches for a convenient import.

```js
rules: {
  'no-restricted-imports': ['error', {
    patterns: [{ group: ['@vercel/*'], message: 'Host-coupled. See MASTER-PLAN §13.2.' }],
  }],
  'no-restricted-syntax': ['error',
    { selector: "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name='runtime'][init.value='edge']",
      message: "Edge Runtime does not exist on the Windows Server. Use the Node runtime." },
    { selector: "MemberExpression[object.property.name='env'][property.name=/^VERCEL/]",
      message: 'Read host config from lib/env.ts, never process.env.VERCEL* directly.' },
  ],
}
```

**3. `next.config.mjs` — `standalone` from day 1.** Produces a self-contained Node bundle. Harmless on Vercel; the entire deployment artifact on Windows. Setting it now means the first server build is not also the first time you have tried this flag.

```js
export default { output: 'standalone', poweredByHeader: false, reactStrictMode: true }
```

**4. `lib/storage.ts` — one narrow interface.** Every upload, download, and signed URL goes through `put` / `get` / `signUrl` / `remove`. Supabase Storage stays the implementation on both hosts, so this is insurance rather than a planned swap — but it is four functions, and it means "move files to a UNC share" is one file rather than a search across the codebase.

**5. `deploy.ps1` — committed, not remembered.** `git pull` → `npm ci` → `npm run build` → `Restart-Service istifada-hub-web, istifada-hub-worker`. Written on day 1 even though nothing runs it until cutover, so the deploy procedure exists in the repo rather than in someone's head.

**Cutover checklist — the actual day:**

1. Provision + prerequisites (§13.3 steps 1–2): long paths, UTC, Node, antivirus exclusion.
2. Reverse proxy + certificate (steps 3–4).
3. Copy env vars from Vercel, changing **two** values: `NEXT_PUBLIC_SITE_URL` → your domain, `DEPLOY_TARGET` → `server`.
4. Register both services with NSSM (step 5).
5. Run `deploy.ps1`. Smoke-test: log in, open a document, verify one entry, generate an export.
6. **Delete the Vercel Cron entry** — otherwise both drain the queue. Harmless thanks to `SKIP LOCKED`, but it doubles the API spend.
7. Point DNS at the server. Keep the Vercel deployment alive and untouched for a week as an instant rollback.
8. Update Supabase Auth redirect URLs to the new domain, and add it to the allowed origins list.

Step 8 is the one people forget: auth silently breaks on the new domain if the redirect URL is still `*.vercel.app`.

---

## 14. The phase plan — six phases

**Phase 1 is the only one with a hard deadline.** Everything after it is sequenced by dependency, not by date, and Phase 4 is gated on hardware rather than on work.

| # | Phase | Duration | Starts when | Deadline? |
|---|---|---|---|---|
| **0** | **Prerequisites** (§11) | ~40 min, yours | Now | Before 1A day 1 |
| **1A** | **The portal** (§11.1) | **7 days** | Phase 0 done | **Hard** |
| **1B** | **Verification & review** (§11.2) | ~5 days | 1A shipped | No |
| **2** | **Analytics engine** | ~5 days | ~200 verified documents exist | No |
| **3** | **Two-way integration** | ~4 days | A populated Main export exists | No |
| **4** | **Windows Server cutover** (§13.3, §13.7) | ~1 day | Server provisioned | No — independent of 1B, 2, 3 |
| **5** | **Event operations** | Ongoing | Event begins | Continuous |

**Six phases; seven stages, because Phase 1 splits.**

### Phase 1A — The portal (7 days, hard)

Unify, enrich, reconcile, report, and push the two Hub statuses outward. Four of the five pillars. **This is a complete system on its own** — it replaces the Excel reconciliation from the day it ships, with no OCR involved. Detailed in §11.1, acceptance in §15.1.

Building it first has three concrete benefits beyond sequencing preference:

1. **Schedule certainty on the deadline.** The portal is known work — schema, import, CRUD, views. Estimable. OCR is unknown work. Putting the estimable thing under the hard deadline and the unknown thing after it is the right way round.
2. **`gold.json` stops being a day-1 blocker.** It is needed before 1B day 5, which buys you two weeks instead of one evening.
3. **Real verified entries exist before the review queue is built**, so the queue is designed against real data rather than fixtures.

The one risk it introduces — discovering an OCR problem late — is bought off by the **half-day CLI spike on 1A day 2** (§11.1). No UI, no schema, ~$2: just enough to prove extraction works on your actual documents before committing a phase to it.

### Phase 1B — Verification and review (~5 days)

Pillar 2. Document upload and inbox, the extraction pipeline, the keyboard-first review queue, the correction log, and the accuracy harness. Detailed in §11.2, acceptance in §15.2.

### Phase 2 — Analytics engine (~5 days)

The pattern-based work that genuinely needs history to exist first. Cut from Phase 1 for exactly that reason (§12), not for time.

1. **Item catalog + `item_key` normalization** — LLM-assisted clustering of verified line-item descriptions into canonical items, with human confirmation. Back-fills `rate_reference.item_key`, which has been accumulating since Phase 1 day 4.
2. **Rate comparison** — same item across vendors; the automated version of this year's Excel rate card.
3. **Rate drift** — same vendor, same item, rate over time.
4. **Vendor clustering detection** — GSTIN-prefix, phone, and address matching over the vendor identities captured in Phase 1. Proposes clusters; **never auto-merges** — it affects payment routing.
5. **`flags-run`** — duplicate payment, discount inconsistency, missing documentation. Writes to the `flags` table that already exists.
6. Morning digest by email, and Playwright coverage of the review-save path.

**Prerequisite:** roughly 200+ verified documents. Below that the comparisons are noise.

### Phase 3 — Two-way integration (~4 days)

1. **Main-side import** — the mapping is written in Phase 1 against Sheet 2's contract; this wires and tests it against a real file, and populates `main_amount`, closing the variance report.
2. **API push-back** — replaces the reviewed `.xlsx` with a direct call. `format = 'api'` is already in the constraint; the transform is already shared. Config plus an endpoint.
3. **Advance settlement workflow** — the UI around `settles_entry_id`, so advances net against final invoices instead of double-counting utilisation.

**Prerequisite:** a populated Main export, and answers on how advances are settled today (§17).

### Phase 4 — Windows Server cutover (~1 day)

Independent of Phases 2 and 3 — run it whenever the server lands. Steps in §13.3, checklist in §13.7. Vercel stays live and untouched for a week afterwards as instant rollback.

### Phase 5 — Event operations (ongoing)

Not development. Queue depth watched daily, OCR spend checked weekly against the $200 ceiling, escalation rate monitored (above 25% means the Haiku prompt needs tuning), reviewer throughput tracked against §7's arithmetic, and the export queue drained so the modules are never waiting. The runbook (§16) is what makes this someone else's job rather than yours.

---

## 15. Definition of done

Binary checks on the production URL with real data. Not "mostly", not "with a known issue".

### 15.1 Phase 1A — the portal

**Data**
- [ ] The real Departmental file imports to 16 entries + 10 allocations; a second import reports 16 unchanged
- [ ] `zone_id`, `hub_reference`, and `hub_status_id` survive a re-import untouched
- [ ] All 42 heads, 13 zones, and both status dimensions seeded
- [ ] Every unmatched budget head and unknown status raises an exception instead of a null
- [ ] `sum(entry tenant_amount) == allocation.utilised_amount` holds per head, or raises

**Workflow**
- [ ] An admin can dry-run an import, read the diff, and commit it
- [ ] A reviewer can set zone, head, and Hub reference on an entry
- [ ] Setting a Hub status queues it for export; a batch produces an `.xlsx` keyed on both UBBL and Main number
- [ ] Re-changing an exported status re-queues it; the prior batch is unchanged
- [ ] Exceptions can be resolved only with a note

**Security**
- [ ] A department-1 reviewer sees zero department-2 rows in tables **and in all eight views**
- [ ] A `viewer` cannot update; a `reviewer` cannot delete
- [ ] `updated_by` always reflects the acting user
- [ ] No secret carries a `NEXT_PUBLIC_` prefix; `supabase db advisors` clean
- [ ] CSP running report-only with zero violations on 1A screens

**Operations**
- [ ] Live on your domain with real logins
- [ ] Sentry receiving errors; uptime check live
- [ ] A backup **restored** into `dev`, not merely taken
- [ ] Failed imports visible in the UI, not only in logs
- [ ] Runbook exists for the 1A workflows and a colleague has followed it once

### 15.2 Phase 1B — verification and review

- [ ] `npm run score` meets every bar in §9.1 against `gold.json`
- [ ] Cheque and passbook pages classified non-financial 100% of the time
- [ ] The Gujarati document escalates to Sonnet automatically
- [ ] Measured cost per document recorded and within the §6 estimate
- [ ] A reviewer verifies a document end to end without the mouse, median under 3 minutes
- [ ] A document with no matching entry uploads, sits in the inbox, and is attachable
- [ ] `/accuracy` shows per-field agreement and at least one real correction pattern from live review
- [ ] `rate_reference` accumulating from verified line items
- [ ] CSP **enforced** (not report-only) with the document viewer working
- [ ] Phone upload works over mobile data

## 16. Operator runbook — what day 7 produces

Two pages, written for someone who was not in any of these conversations.

1. **Daily** — import today's export; work the document inbox; drain the review queue; clear exceptions above ₹50,000; generate the export batch if any statuses changed.
2. **Importing** — where the file comes from, dry-run first, how to read the preview, when to stop and ask.
3. **Reviewing** — the keyboard shortcuts, what the three tally numbers mean, when to flag rather than fix.
4. **Exceptions** — what each type means in plain language, and who resolves which.
5. **Exporting statuses** — when to generate, who receives it, how to confirm it was applied.
6. **When something looks wrong** — the four things to check before escalating, and who to call.
7. **What never to do** — never edit in the database directly; never delete a document; never share a login.

---

## 17. Still open — answer when you can

None of these block the seven days. Each one improves something specific.

1. **Does central IT need the CSP header value for review, and do they want violation reports routed anywhere?** (§4.4b) The policy is set in the app, not the proxy — worth confirming they're happy with that before cutover, since it means nothing to configure in IIS.
2. **Reverse proxy: IIS or Caddy?** Check with IT before the server is provisioned. Caddy removes the certificate-renewal task entirely and saves about half a day; IIS is the safe default if policy requires it. (§13.3)
3. **When will the Windows Server be provisioned?** Not a blocker — week 1 ships on Vercel either way — but it sets when the ~1-day cutover gets scheduled, and the Vercel Pro cost runs until then. (§13)
4. **Hub-status lifecycle.** Does `awaiting verification` always precede `awaiting validation`? What state follows validation — does the Hub set it, or does the module report back? Can either be reverted, and by whom? The schema hard-codes no sequence, so this is a config answer, but the UI needs it to know which transitions to offer.
5. **Who receives the export, in what form?** A file handed to a person, a shared folder, or an endpoint? And does either module acknowledge that it applied the change — or is delivery assumed?
6. **`Approved Amount = 0` on every head** while ₹2.32 crore is utilised — is that real, or is this export pre-approval? Budget-vs-actual has no denominator until this is settled.
7. **The `hub_reference` column** (v1's `new`) — one real example value and I will model it properly instead of leaving it free text.
8. **`APS`** — still undefined, still blocking one KPI.
9. **Sheet 2's `Type` column** — what are the permitted values? Currently guessing `invoice` / `reimbursement` / `advance_payment` from an `ADP_` prefix.
10. **Advance settlement** — how does an `ADP_` advance get netted against the final invoice today? `settles_entry_id` exists; the workflow around it does not.
11. **UBBL ↔ Main Entry Number** — guaranteed 1:1, or can one UBBL split into several Main entries?
12. **Vendor master** — do you have GSTIN / phone / bank details anywhere, or is the invoice the only source?
13. **TDS** — deducted at source on these contractor payments? Credit notes ever issued?
14. **Zones for other departments** — is zoning Venue-Setup-only, or does each department get its own list?
15. **Users** — how many staff, in how many roles, and should departments see each other's spend?
16. **Hijri dates** — the event is 1447H. Do reporting periods need Hijri alongside Gregorian?
