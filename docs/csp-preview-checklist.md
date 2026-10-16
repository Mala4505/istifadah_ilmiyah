# CSP preview click-through checklist (plain English)

**What this is.** The app has a safety rule list (the "Content Security Policy") that tells the browser
which scripts, images and connections are allowed. Right now it only *reports* problems; it does not
*block* anything. Before we switch it to blocking, we try it on a throwaway test copy of the site
(a Vercel "preview") and you click through every screen. If a screen looks blank or a button does
nothing, the rule list needs one more entry, and we fix it before it touches the real site.

**Who does what.**
- A developer (or the next Claude session) sets up the test copy in steps A to C below.
- You do the click-through in "Part 2". It takes about 20 minutes.
- Nothing here changes the real site until you say "all clear".

---

## Part 1 - Setting up the test copy (developer / Claude session)

A. In the Vercel dashboard, open the project, then Settings, then Environment Variables. Add
   `CSP_REPORT_ONLY` = `false` and tick **Preview only** (leave Production and Development unticked).

B. Push a branch (or redeploy any recent preview) so Vercel builds a preview with that setting.
   Open the preview link it gives you. It looks like `https://istifadah-ilmiyah-git-<branch>-<team>.vercel.app`.

C. Quick technical proof (developer): in a terminal run
   `curl -sI <preview-url>/login` and check the output contains `Content-Security-Policy:`
   (not `Content-Security-Policy-Report-Only:`) and `X-Frame-Options: DENY`. Also
   `curl -sI <preview-url>/api/documents/status` should show `X-Content-Type-Options: nosniff` and
   `Cache-Control: no-store`.

Note on the preview only: Vercel adds its own little comment toolbar to preview pages. When the
rules are enforced, the browser may refuse that toolbar and print a "Refused to ..." message
mentioning `vercel.live`. That is expected, only exists on previews, and is **not** a problem. Ignore
anything that mentions `vercel.live`.

---

## Part 2 - Your click-through (use a normal Chrome window, signed in as a superadmin)

How to look for problems: on each screen, press **F12** once (opens a side panel), click the tab called
**Console**, and leave it open. Red lines that start with "Refused to ..." are what we are hunting
for. If you do not want to use the console, just tell us anything that looks blank, half-loaded, or any
button that does nothing. Screenshots help.

Tick each line when it works. Write down the page name for anything that does not.

1. **Login**
   - [ ] Sign out, open the preview link, the login page appears with the form fully drawn.
   - [ ] Type your ITS number: the letters appear as you type (this proves the page "woke up").
   - [ ] Sign in works and takes you to the dashboard.
2. **Dashboard (home page)**
   - [ ] Tiles and numbers appear, nothing stuck on "loading".
3. **Entries**
   - [ ] The list loads. Open the filter panel and try two or three filters, plus sorting.
   - [ ] Click one entry to open its detail page.
   - [ ] Press the CSV export button: a file downloads.
4. **Documents**
   - [ ] The inbox lists documents with their progress bars.
   - [ ] Upload one small PDF: it shows progress, then appears in the list.
5. **Review**
   - [ ] Open a document from the queue: the bill image/PDF appears on the left.
   - [ ] Zoom in and out, move between pages.
   - [ ] Line items show on the right; edit one value and press Save. Saving works.
   - [ ] Try the "re-extract" button on a test document (only if you are happy to spend one OCR run).
6. **Reports** (open each tab and wait for charts to finish drawing)
   - [ ] Reports home / landing page.
   - [ ] Brief.
   - [ ] Budget.
   - [ ] Integrity.
   - [ ] Vendors.
   - [ ] Change the comparison period (top bar): charts redraw.
   - [ ] Board pack: press Download and a file arrives (if you have a pack generated).
7. **Import**
   - [ ] The page loads. The history table fills.
   - [ ] The bookmarklet "drag link" is visible (do not need to run it).
   - [ ] Run a small **dry run** import with a test spreadsheet: a result appears.
8. **Exceptions, Accuracy, Shortcuts**
   - [ ] Each page opens and shows its content.
9. **Settings and Account**
   - [ ] Settings opens; the Events switcher works (switch events and switch back).
   - [ ] Admin / staff list shows (superadmin only).
   - [ ] Account page opens.
10. **Sign out**
   - [ ] Sign out returns you to login.

Also try once on your **phone** (camera upload is a real use):
   - [ ] Open the Documents page and take a photo of a bill to upload it.

---

## Part 3 - Sending results back

- If everything ticked: tell the developer "preview is clean". Then a developer sets
  `CSP_REPORT_ONLY=false` in **Production** in Vercel, redeploys, and changes the default in
  `lib/env.server.ts` (the `CSP_REPORT_ONLY` default from `'true'` to `'false'`).
- If anything failed: send the page name and a screenshot of the red "Refused to ..." lines. The usual
  fix is adding one allowed address to the rule list in `middleware.ts`; then redo only that page.

## Extra: where reports go now

Before this change nothing collected the "this would have been blocked" reports; they were only visible
in each person's own console. `middleware.ts` now adds a `report-uri` that sends them to Sentry
(built from `NEXT_PUBLIC_SENTRY_DSN`; skipped when that is empty). So, besides your click-through, a
developer can open Sentry and look for "CSP" reports from real users during the burn-in.

## Rollback

If production ever breaks after the switch: Vercel, Settings, Environment Variables, set
`CSP_REPORT_ONLY` back to `true`, redeploy. That returns to report-only (nothing blocked).
