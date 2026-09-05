# Where OCR Should Execute — Decision Doc

**Status:** Tradeoffs only. Nothing built, nothing decided. Written 2026-08-22 at the user's request.

**2026-09-05 note:** the deployment tier was confirmed as Vercel Hobby (performance-remediation-plan.md 3.5), which changes §1's math — the platform kills any function at 10s regardless of its declared `maxDuration`, so the "15s wall clock" 8-page sample below was already being truncated by the platform, not just approaching a 60s ceiling. `INGEST_INLINE_EXTRACTION` now defaults to `false` (see `import-review-ux-plan.md` §15's supersession note and `lib/env.server.ts`) rather than the `true` this doc's §0.1 describes as current.

Companion to [`event-scoping-and-review-fixes-plan.md`](./event-scoping-and-review-fixes-plan.md). This doc exists because the punch-list plan sequenced "move extraction to the background worker" as high priority, and investigating *which* worker turned up a wrong assumption worth correcting before any work starts.

---

## 0. The correction: GitHub Actions is a scheduler, not a worker

`.github/workflows/cron-tick.yml` looks like a background worker and is not one. Its entire job step is:

```
curl --max-time 55 -X POST "$SITE_URL/api/jobs/tick"
```

The extraction still runs **on Vercel**, inside `app/api/jobs/tick/route.ts`, which declares `maxDuration = 60` and a `DRAIN_BUDGET_MS` of 50 seconds — the same ceiling `app/api/documents/ingest/route.ts` already hits. A bundle too large to extract in 60 seconds fails there identically.

Two consequences:

- **It does not solve the timeout.** Not partially, not for slightly larger documents. The executor never moved.
- **It cannot deliver "OCR starts the moment the document is uploaded" either.** The schedule is `*/5 * * * *`, and GitHub's scheduler runs late under load — 5 to 15 minutes in practice.

What it *is* good for, and should be kept for: it is the only thing that ever retries a failed or abandoned job. Before it existed, nothing called `/api/jobs/tick` at all. Keep it regardless of which option below is chosen.

## 0.1 The other correction: instant start is already built

`INGEST_INLINE_EXTRACTION=true` (default) makes `app/api/documents/ingest/route.ts` run this document's own extraction job synchronously before responding. Page 1 reaches Claude a second or two after the file lands.

So the requirement "OCR should start the moment the doc is uploaded" is **already met today**. The problem is not starting. The problem is *finishing* a bundle that does not fit in one 60-second request.

That reframes the decision: nothing here is about making OCR start sooner. Every option below is about how to finish long jobs **without losing** the instant start that already works.

---

## 1. The measured ceiling

From `source_document` 16, a real 8-page bundle: 8 pages, extracted 4 concurrently, ~7.7 s per batch, 15 s wall clock total.

| Pages | Batches | Extraction time | Outcome |
|---|---|---|---|
| 8 | 2 | ~15 s | Measured, fine |
| 20 | 5 | ~39 s | Fine |
| 28 | 7 | ~54 s | At the edge |
| 50 | 13 | ~100 s | Times out |

**Practical ceiling: 25–30 pages.** Above that the request is cut off mid-extraction. The file is safely stored and the job row remains queued, so nothing is lost — but the user sees a failure, and the bundle stays unprocessed until the cron tick happens to pick it up (where it will fail again the same way, on the same 60-second cap).

---

## 2. The options

### A. Chunked continuation — extraction becomes resumable

Keep extraction inline. Process as many pages as fit in the request budget, return a partial result, and have the client immediately request the next chunk. Repeat until done.

**Fit with the existing architecture is unusually good.** Extraction is already strictly per-page, and `document_page` rows already record which pages have received a verdict — so "which pages remain" is already a query, not new state to invent.

**The real work:** `extractAndPersist` currently always processes every page of the document and restarts `bill_index` at 0 on each run. It would need to accept a page range and append to existing bills rather than renumbering from scratch. Contained, but genuinely a change to the most load-bearing function in the pipeline. Plus a progress indicator on the documents screen.

| | |
|---|---|
| Instant start | Preserved |
| Page ceiling | None |
| Cost | Free |
| New infrastructure | None |
| Depends on | Nothing staying alive |
| Effort | Highest of the four |

**Risk to weigh:** if the browser closes mid-way, the remaining chunks are not requested. The existing GitHub Actions tick covers this — but only if the per-chunk work fits inside *its* 60-second budget too, which it does by construction once chunking exists. This is the option that finally gives that workflow a real job.

### B. Run `worker/index.ts` on an always-on machine

Already written. Standalone Node process, infinite claim-and-run loop, no timeout of any kind, polls every 2 seconds — so OCR would start ~2 s after upload and could process a 500-page bundle without special handling. `MASTER-PLAN` §13 always intended this ("Windows Service on cutover").

**Ruled out as the primary path (2026-08-22):** the available machine sleeps or gets shut off. A worker that silently stops is worse than no worker, because uploads queue up looking successful and nobody notices until someone goes looking. Retained here only because it becomes the best option the day a reliably-on machine exists.

### C. GitHub Actions as a genuine executor

Trigger via `repository_dispatch` from the ingest route, and run the extraction **inside the runner** rather than curling Vercel.

This does move the executor, and runners have a 6-hour limit, so the page ceiling disappears. But:

- **Runner cold start is 30–60 seconds** — checkout, Node setup, dependency install — before the first page is even read. That directly fails the "starts the moment it's uploaded" requirement, which every other option preserves.
- Private-repo Actions minutes are capped on the free plan. A 50-page bundle is roughly 2 minutes of extraction plus ~1 minute of overhead.
- It is CI infrastructure used as a job queue: no real concurrency control against `job_queue`, awkward failure semantics, and secrets spread across another system.

**Assessment:** works, but it is the worst fit for the stated requirement while being roughly as much setup as option A.

### D. Vercel Pro

Raise `maxDuration` from 60 to 300 seconds. Effectively a one-line change; the ceiling moves from ~30 pages to roughly ~150.

| | |
|---|---|
| Instant start | Preserved |
| Page ceiling | ~150 pages |
| Cost | $20/month |
| Effort | Minutes |

**This does not remove the ceiling, it moves it.** Whether that is a fix or a stopgap depends entirely on §3.

---

## 3. The unknown that actually decides this

**How many pages is the largest bundle that will realistically be uploaded?**

Nothing in the codebase or the data answers this. Five documents exist; the largest is 8 pages. The stated expectation is that every PDF will be multi-page and multi-department, but not how large.

- **If real bundles top out around 100 pages:** option D alone is a complete answer. $20/month, minutes of work, done. Building option A would be engineering for a problem that never arrives.
- **If bundles can run to several hundred pages:** option D only delays the failure, and option A is the real answer.

**Recommended next step before choosing:** measure. Take the largest bundle that will genuinely be uploaded in a normal week and count its pages. That single number decides between a $20 configuration change and a substantial piece of engineering.

---

## 4. Recommendation

**Staged, and the two are not mutually exclusive:**

1. **Now — option D**, if the $20/month is acceptable. Minutes of work, immediate relief from ~30 to ~150 pages, and it buys room to decide the rest without a live failure hanging over uploads.
2. **Measure** the real maximum bundle size against that new ~150-page ceiling.
3. **Then — option A**, only if the measurement says it is needed.

**Keep `.github/workflows/cron-tick.yml` in every scenario.** It is the only retry mechanism that exists, and under option A it graduates from a safety net into a real part of the design.

**Revisit option B** if a machine that stays on ever becomes available — it is already written, and it is strictly the cleanest answer when the reliability precondition holds.
