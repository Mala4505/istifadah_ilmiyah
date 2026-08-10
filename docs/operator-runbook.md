# Hub Operator Runbook

For staff running the Istefadah Ilmiyah reconciliation Hub day-to-day. No technical background assumed — this covers the screens that exist today only.

**Your role decides what you can do.** Every account is one of three roles, set by an admin when your account was created:

- **Viewer** — can look at everything for their department, can change nothing.
- **Reviewer** — everything a Viewer can do, plus: edit an entry's department fields, change its Hub status, and resolve exceptions — for their own department.
- **Admin** — everything a Reviewer can do, across every department, plus: run imports, generate export batches, create/manage staff accounts, map budget heads, and merge vendors.

If a button doesn't work or a save doesn't stick, the first thing to check is whether your role allows it (see section 6).

---

## 1. Daily

Work through this list at the start of the day:

1. **Import today's export.** If an admin, open **Import** and load the latest Departmental file (see section 2). If you're not an admin, ask one to run it.
2. **Document inbox and Review queue are not built yet** — these are coming in a later phase. Skip them; there is nothing to do here today.
3. **Check Exceptions.** Open **Exceptions**, sort by severity (already the default), and resolve or dismiss anything above roughly **₹50,000 at risk** first. Everything else can wait, but don't leave the queue unread.
4. **Generate an export batch if any Hub status changed today.** If you (or a reviewer) set an entry's status to Awaiting Verification or Awaiting Validation today, an admin should generate and send a status export batch before the day ends (section 5).

---

## 2. Importing

Only admins can do this.

1. Get the latest Departmental export file (`.xlsx`) — the same spreadsheet the department already produces.
2. Go to **Import**. Choose the file, then click **Run dry-run preview** — nothing is written to the system yet at this point.
3. Read the preview:
   - A summary shows how many rows were inserted, updated, unchanged, or skipped.
   - Any **new budget heads or new vendors** the file introduced are called out — these get created automatically, so just eyeball that the names look right.
   - Any **exceptions** raised are listed with a severity and a plain description — e.g. a budget head's total no longer matches the sum of its entries, or the same reference number is being used two different ways, or a status word the system hasn't seen before.
4. **When to stop and ask instead of committing:**
   - The dry run's overall status shows **failed** — don't commit, get help.
   - A **high severity** exception appears that you don't recognise as expected (e.g. a large allocation mismatch).
   - The row counts look wildly different from a normal day's import (e.g. thousands of "skipped" rows).
   - If none of that applies, click **Commit this import**. Once committed, the batch is permanent — you can view it later in batch history, but not undo it by re-running.

---

## 3. Reviewing

**The dedicated review queue (with keyboard shortcuts) is not built yet — coming soon.** Until it ships, day-to-day review happens through **Entries**:

1. Open **Entries**, find the entry (search or filter by department/vendor/status).
2. Open it to see the **Enrichment** tab — fill in admin head, zone, budget category, and any remark. This is the only place these fields are edited; importing never overwrites them.
3. For an invoice that settles an earlier advance payment, use the advance-settlement picker on the entry to link the two.
4. Use the **Hub status** panel on the entry to move it to Awaiting Verification or Awaiting Validation once you're satisfied with it. **A note explaining why is required every time** — the system will not let you save a status change without one.
5. The **Change history** tab shows every edit made to the entry, who made it, and when — check this if something looks off.

---

## 4. Exceptions

Open **Exceptions**. Each row is a discrepancy the system found automatically, with a severity (High / Medium / Low) and, where relevant, a Rupee amount at risk.

**What you'll actually see today** (raised automatically during import):
- **Unknown status code** (Low) — the file used a status word the system hasn't seen before. It still imported fine; this is just a heads-up.
- **Allocation sum mismatch** (High) — a budget head's reported total doesn't match the sum of its individual entries. Worth a close look before trusting that head's numbers.
- **ID namespace collision** (High) — the same reference number is being used as both a UBBL Number and a Main Entry Number on different entries. Needs a human to sort out which one is right.

**Types you'll start seeing once document review ships** (not active yet — nothing to do about these today): line-item tally mismatch, OCR total vs. amount, department vs. Audit variance, duplicate document, missing documentation.

**Who resolves which:** any Reviewer or Admin can resolve or dismiss an exception in their own department; Admins can act on any department. There's no further split by exception type — whoever is working that department's queue handles whatever is in it.

**How:** open the exception, choose Resolve or Dismiss, and **write a note explaining why** — this is required, the same as a status change. "Resolved" with no explanation is not acceptable; someone else needs to be able to understand the decision later.

---

## 5. Exporting statuses

Only admins can do this. This is the only way the Hub's decisions (Awaiting Verification / Awaiting Validation) leave the system and reach the other modules.

1. Go to **Export**. The **Pending queue** shows every entry with a Hub status set but not yet sent out.
2. Click **Generate a batch**. This bundles up *everything* currently pending — it doesn't matter which target system you pick, all pending entries go into the one file.
3. **When to generate:** whenever the pending queue isn't empty at the end of the day, or sooner if there's a batch of urgent decisions to send.
4. **Who receives it:** `[Contact/process: fill in — not yet decided; MASTER-PLAN §17 flags this as still open]`.
5. Download the file and deliver it however you're told to (email, shared folder, etc. — not yet automated).
6. Once it's sent, click **Mark delivered** on that batch.
7. Once the receiving module confirms it applied the change, click **Mark acknowledged**. Until you hear back, leave it as delivered — don't guess.
8. A generated batch is permanent and never rewritten. If something about a batch looks wrong, do not generate a new one to "fix" it — see section 7.

---

## 6. When something looks wrong

Check these four things, in order, before escalating:

1. **Read the error message on screen.** Import and export failures show a specific reason (e.g. "file upload failed", "no file available for this batch") — it usually says exactly what broke.
2. **Check your role and department.** A save that silently does nothing, or a message like "nothing was updated" / "0 rows updated", almost always means your role doesn't have permission for that action, or the entry belongs to a different department than the one you're assigned to. This is not a bug.
3. **Check Exceptions** for a matching flag — many "this number looks wrong" situations already have an explanation sitting there.
4. **Check Reports → Hub-status ageing and Open issues digest** for entries that have been stuck a long time or have other open flags attached.

If none of that explains it: **`[Contact: fill in]`**.

---

## 7. What never to do

- **Never edit the database directly.** Every change must go through the app's own screens and buttons — that's the only way a required note, an audit trail, and the correct permission check all happen together.
- **Never delete a document.** Nothing in the Hub is designed to delete source evidence — if something was attached in error, it should be flagged, not removed.
- **Never share a login.** Every account is tied to one person's ITS number. If someone needs access, ask an admin to create them their own account — don't hand over your password.
- **Never skip the dry-run step before committing an import.** Always run the preview and read it before clicking Commit.
- **Never re-generate an export batch to "fix" a previous one.** If a batch looks wrong after it was already sent, ask an admin before generating another — a duplicate can look like the same status change was sent twice.
- **Never merge a vendor unless you're sure.** It affects payment routing. It can be undone, but only an admin should make that call, and only after checking it's genuinely the same vendor.
