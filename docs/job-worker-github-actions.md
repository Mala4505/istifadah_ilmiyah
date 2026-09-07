# Job queue worker on GitHub Actions

The background job queue (`job_queue` — document extraction, board packs,
flag runs, batch polling) is drained by **`worker/index.ts` running as a
GitHub Actions job**, defined in `.github/workflows/worker.yml`.

## Why it runs here

On Vercel Hobby the platform hard-kills any function at ~10 s. A real
extraction bundle takes 15–45 s (`docs/ocr-execution-decision.md`). So the
in-process paths can't finish one:

- the upload route (`INGEST_INLINE_EXTRACTION`, now `false`), and
- `/api/jobs/tick` — which ran the *same* handler and hit the *same* wall,
  which is why the old `cron-tick.yml` (curl `/api/jobs/tick` every 5 min)
  started failing with `curl (28) Operation timed out`.

A GitHub Actions job has no such limit (only this workflow's
`timeout-minutes: 15`), so it runs the handler to completion.

## How a run starts

| Trigger | When | Purpose |
| --- | --- | --- |
| `repository_dispatch` (`run-worker`) | fired by `lib/jobs/trigger-worker.ts` right after a document upload or a "generate board pack" click | **primary** — extraction starts within seconds |
| `schedule` (`0 */3 * * *`) | every 3 hours | backstop — retries failed / killed-mid-run jobs, and runs the self-rescheduling `board_pack` / `flags_run` jobs |
| `workflow_dispatch` | manual "Run workflow" button in the Actions tab | testing, and draining a backlog on demand |

`worker/index.ts` runs in **bounded mode** here (`WORKER_EXIT_WHEN_IDLE=true`,
`WORKER_MAX_RUNTIME_MS=600000`): it sweeps for stale rows, drains everything
queued, then exits 0. With both env vars unset (local `npm run worker`, or the
Windows Service on cutover) the same file loops forever instead.

## One-time setup

### 1. Repository **secrets**
`Settings → Secrets and variables → Actions → Secrets → New repository secret`.
Use the same values as the Vercel deployment:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `NEXT_PUBLIC_SENTRY_DSN` (optional — leave unset to disable Sentry in the worker)
- `SUPABASE_SECRET_KEY`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`

### 2. Repository **variables**
Same screen, **Variables** tab. Not secret, and easier to read back when debugging:

- `SITE_URL` — the deployed origin, e.g. `https://istifadah-ilmiyah.vercel.app`
  (already set if the old `cron-tick.yml` was configured). Must be a full URL —
  the worker validates it as one at startup.
- `COMMUNITY_GSTIN` — the org's own GSTIN. **Set this** — without it, extraction
  can misread the org's own GSTIN (printed as the recipient) as the vendor's.
- `COMMUNITY_NAME` — the org's canonical name, for the recipient-compliance check.
- `OCR_AUTO_ESCALATION` — `false` unless you want every low-confidence /
  non-Latin bill re-run on Sonnet.
- `OCR_USE_BATCH_API` — `false` (synchronous extraction).

### 3. The dispatch token (so uploads trigger a run immediately)
Without this, extraction still works — it just waits up to 3 h for the
scheduled run. To make it near-instant:

1. Create a **fine-grained personal access token**
   (`Settings → Developer settings → Personal access tokens → Fine-grained`),
   scoped to **only** `Mala4505/istifadah_ilmiyah`, with **Repository
   permissions → Contents: Read and write** (what the `/dispatches` endpoint
   requires). Set a long expiry and a calendar reminder to rotate it.
2. Add it to **Vercel** (Project → Settings → Environment Variables), **not**
   to this repo:
   - `GITHUB_WORKER_REPO` = `Mala4505/istifadah_ilmiyah`
   - `GITHUB_WORKER_DISPATCH_TOKEN` = the token
3. Redeploy Vercel so it picks them up.

### 4. Merge to `master`
`repository_dispatch` and `schedule` triggers only fire for a workflow file
that exists on the **default branch**. Nothing runs until `worker.yml` is on
`master`.

## Clearing the current backlog

The two PDFs already stuck (and any others) will be picked up automatically by
the first run once the workflow is live — the startup sweep reclaims any row
left `running` by the killed cron attempts. To force it now:
`Actions → Job queue worker → Run workflow`.

## Actions-minutes budget

Private-repo free tier is **2,000 minutes/month**. Each run is roughly
`npm ci` (~1 min cached) + drain time.

- Scheduled backstop: 8 runs/day × ~2 min ≈ **480 min/month**.
- Upload-triggered: ~2 min per run, but one run drains the *whole* queue, so a
  burst of uploads collapses into far fewer runs than uploads. Budget ~1 min
  per document as a rough ceiling.

At ~30–40 documents/day this lands comfortably under 2,000. If volume grows,
options in order of preference:

1. Widen the schedule (`0 */6 * * *`) — the upload trigger already covers
   promptness; the schedule is only for retries.
2. Make the repo **public** — Actions minutes are then unlimited. (No secrets
   live in the repo; they're all in Actions secrets / Vercel.)
3. Move the worker to an always-on host (Oracle Cloud Always Free VM, or the
   Windows Service the cutover plan already anticipates).

Watch usage at `Settings → Billing → Plans and usage`.

## Related

- `lib/env.server.ts` — `INGEST_INLINE_EXTRACTION`, `GITHUB_WORKER_*` doc comments
- `docs/performance-remediation-plan.md` item 3.5 — the history
- `skill-observations/log.md` Observation 70 — why the previous approach failed
