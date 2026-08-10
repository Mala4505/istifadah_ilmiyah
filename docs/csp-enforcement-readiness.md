# CSP Enforcement Readiness

Tested `CSP_REPORT_ONLY=false` (enforced CSP, per `middleware.ts` / MASTER-PLAN §4.4b)
against a production build (`npm run build` + `next start -p 3117`, port 3000 was already
occupied by another parallel agent's server) on 2026-08-10. Driven with a headless
Playwright/Chromium session (installed to the scratchpad, not the project — nothing added
to `package.json`).

## What was tested

Full page sweep, enforced CSP, with browser console + network monitoring:
`/login`, `/` (redirects to login), `/entries`, `/documents`, `/review`, `/reports`,
`/reconciliation`, `/import`, `/export`, `/exceptions`, `/admin`, `/accuracy`. Plus one
interactive check: typing into the `/login` ITS-number field and confirming the value
lands in the DOM (proof React actually hydrated, not just that the HTML looked clean).

pdf.js is **not wired up yet** — confirmed via `grep` (no `pdfjs-dist`, `workerSrc`, or
`isEvalSupported` usage in any `.ts`/`.tsx` file) and the `documents`/`review` pages are
still `ScreenStub` placeholders (Phase 1B work not landed). The `worker-src`/`img-src blob:`
concerns §4.4b calls out for pdf.js don't apply yet — nothing to test there.

## Finding: enforcing CSP as-is would have broken login for every user

Initial test (before any fix) showed real, blocking violations — not noise. `/login`'s
compiled HTML shipped **zero nonce attributes anywhere**: none on the framework's own
`<script src="/_next/static/chunks/...">` tags, none on the inline hydration payload. Every
script on the page was blocked, so React never hydrated — the login form would render but
be completely dead (no typing, no submit).

Root cause, confirmed by diffing against a genuinely dynamic route: `next build`'s route
table showed `/login` marked `○` (statically prerendered) while `/entries` was `ƒ`
(dynamic) — and `/entries`'s HTML had a correctly matching nonce on every script tag,
including the inline RSC payload. This is exactly the constraint MASTER-PLAN §4.4b states
outright: *"Nonce-based CSP requires dynamic rendering — no static optimization."* Nothing
in the app forces dynamic rendering, so Next's automatic static optimization silently
kicked in for `/login` (a page with no server data fetching), baking its HTML at build time
with no per-request nonce.

**Fix applied:** `app/layout.tsx` now exports `export const dynamic = 'force-dynamic'` at
the root layout, so every route inherits it — one place, not something to remember per new
page. Rebuilt: the route table now shows every route `ƒ` except `/apple-icon.png` and
`/icon.png` (static image assets, no scripts, irrelevant to CSP). Re-tested `/login`'s raw
HTML: every script tag now carries a matching nonce, and the interactive test confirms
hydration works — typing `12345678` into the ITS-number field correctly lands in the DOM.

## Result after the fix: clean

Across all 11 routes + the interactive login test, the only console messages matching
"content security policy" were four identical entries repeated verbatim on *every* page
regardless of content (one `script-src`, three `style-src`, one of which is literally the
SHA-256 hash of an empty string). Confirmed these are **not app-served content**: the same
class of violation (different hashes) also fires when Playwright loads a bare `.png` image
asset with no HTML page at all — i.e., this is Chromium/Playwright's own headless-browser
internal machinery (likely autofill/UI-overlay injection), not anything `middleware.ts` or
the app emits. Recommend the user spot-check in a real, non-automated browser before
sign-off, but there is no code-level evidence these are real.

No other CSP console errors, no page errors, on any of the 11 pages tested.

## Go/no-go recommendation

**Fix is in this worktree; production Vercel env is untouched — that decision is being
surfaced to the user, not resolved here.** Do not push `CSP_REPORT_ONLY=false` to
production yet. Recommend:

1. Merge the `app/layout.tsx` `force-dynamic` fix — without it, enforcing CSP today would
   have broken login for 100% of users. This is a code bug, not a config decision, and it's
   already fixed and verified in this worktree.
2. After merge, still do a short report-only burn-in in production per §4.4b's own
   guidance ("watch the console and Sentry for a few days of real use") before flipping —
   my test covers every route that exists today, but not real user traffic patterns,
   browser extensions, or edge cases like session-expiry redirects mid-flow.
3. Once Phase 1B's document viewer (pdf.js) lands, re-test specifically for `worker-src`
   and `isEvalSupported: false` per §4.4b before enforcing — that's the other named
   fragile spot and it doesn't exist in the app yet.

## Files touched

- `app/layout.tsx` — added `export const dynamic = 'force-dynamic'` (the actual bug fix).
- `.env` (local, git-ignored, not committed) — tested with `CSP_REPORT_ONLY=false`,
  reverted to `true` after testing so the worktree defaults back to the safe report-only
  setting.

`npm run typecheck` and `npm run lint` both pass clean after the `layout.tsx` change.
