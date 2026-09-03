# Istifadah Reporting Blueprint

**Idara Maliyah · Istifadah Ilmiyah Hub · Reporting & Analysis**

> Most systems know who you paid. This one knows what you bought.

An expense ledger stops at the vendor and the amount. This one carries the bill's own line
items underneath every entry — description, quantity, unit, rate, discount, tax. That single
extra level of depth is what turns reporting from **a record of spending into an analysis of
purchasing**.

This is the catalogue of every question the data can answer, and how to build each answer.

| | |
|---|---|
| Reports in the catalogue | **45** |
| Slicing dimensions | **12** |
| Flagship reports | **6** |
| Proposed screens | **5** |
| Zones on the spend map | **13** |

**Scope note.** This blueprint covers business and financial analysis only — entries, line
items, vendors, departments, sub-departments, administrative heads, budget heads, categories
and zones. It deliberately excludes extraction/OCR telemetry and entry-change-log forensics;
those are operational concerns and do not belong on the analysis surface.

**Companion artifact:** https://claude.ai/code/artifact/9928e2ec-a738-402a-b42d-a751ae8e71eb

---

## Contents

1. [The grain — every rupee carries six tags](#1-the-grain--every-rupee-carries-six-tags)
2. [Dimensions and measures](#2-dimensions-and-measures)
3. [Report catalogue](#3-report-catalogue)
   - [Family A — Budget & spend](#family-a--budget--spend)
   - [Family B — Vendors](#family-b--vendors)
   - [Family C — What we bought](#family-c--what-we-bought)
   - [Family D — Entry integrity](#family-d--entry-integrity)
   - [Family E — Executive framings](#family-e--executive-framings)
4. [Six flagships, worked through](#4-six-flagships-worked-through)
5. [Screen architecture](#5-screen-architecture)
6. [Design fixes, in priority order](#6-design-fixes-in-priority-order)
7. [What the data cannot tell you yet](#7-what-the-data-cannot-tell-you-yet)
8. [Build sequence](#8-build-sequence)

---

## 1. The grain — every rupee carries six tags

The whole analytical surface follows from this. Each entry is tagged on six independent axes,
and beneath the entry sits the line item — the level almost no expense system reaches. Any
report in this catalogue is a measure crossed with one or two of these tags.

### The six tags on every entry

| Tag | Question it answers | Source |
|---|---|---|
| Who spent it | department, sub-department | `department` · `sub_department` |
| Who is accountable | administrative head | `admin_head` |
| Where | zone — 13 physical sites | `zone` |
| Against what | budget head, budget category | `budget_head` · `budget_category` |
| To whom | vendor — alias-merged and normalised | `vendor` · `vendor_alias` |
| What kind | invoice, reimbursement, advance, invoice-against-uplaq | `entry_type` |

### …and the level beneath

Every entry can carry its bill's **line items**: description, HSN/SAC code, quantity, unit,
list rate, discount, net rate, line amount and tax — normalised into **item families** so that
rates compare across vendors and across time.

- The six tags give you every conventional report.
- The level down gives you the ones nobody else can run.

### What the extra level actually buys you

| A ledger can say | This data can say |
|---|---|
| "We paid this vendor ₹8 lakh." | **"We bought 4,200 sqft of gypsum ceiling from them at ₹96/sqft, when our median across all vendors is ₹78."** |
| "Department A is at 91% of budget." | "Department A is at 91% with six weeks left, and projects to 118% at the current run rate." |
| "Eight vendors, ₹2.1 crore." | "Eight vendors carry 62% of spend, and three of them share a GSTIN." |
| "Zone spend: ₹14 lakh." | "Zone spend by category, and the unit rate this zone paid versus every other zone for the same item." |
| "Vendor gave a 15% discount." | "Vendor gave 20% to one department and 5% to another, on the same item family, in the same month." |

### Where the findings come from

A finding is a **contradiction between two things the data holds independently**. Three seams
produce almost every report worth reading:

1. **Entry amount vs the bill's own total.**
2. **This purchase's rate vs our own median for the same item.**
3. **Spend vs the approved budget, over time.**

Build the views that expose those three seams and most of this catalogue follows.

---

## 2. Dimensions and measures

Every item below already exists in the schema. No new column is required for anything in this
section.

### Dimensions

| Dimension | Values | Source |
|---|---|---|
| **Event** | Hijri year with start and end dates — the year-on-year axis | `event` |
| **Department** | Top-level owning unit, budgeted | `department` |
| **Sub-department** | Second level, budgeted independently | `sub_department` |
| **Administrative head** | The person accountable for the spend | `admin_head` |
| **Zone** | 13 sites — Khaimat Backside, Begamwadi, Mozzam Sehen, Roza Sehen + Devri, Sehen Power, Maskan Plot, MT School, Dumas School, Gopipura, Najmi Masjid, Shehabi Colony, Office Expense | `zone` |
| **Budget head** | Line of the approved budget, with its own allocation history | `budget_head` |
| **Budget category** | Grouping above the head | `budget_category` |
| **Vendor** | Normalised and alias-merged; confirmed or provisional | `vendor` · `vendor_alias` |
| **Entry type** | Invoice · Reimbursement · Advance · Invoice against Uplaq | `entry_type` |
| **Status** | Import status, plus the Hub's own workflow state | `entry_status` · `hub_status` |
| **Instrument type** | Tax invoice · Bill of supply · Retail cash memo · Letterhead bill · Proforma · Quotation · Receipt · Delivery challan | `document_extraction` |
| **Item family & catalogue item** | The normalised purchase item, with a comparison unit — the level rates compare at | `item_family` · `item_catalog` |

### Measures

| Measure | Definition | Source |
|---|---|---|
| **Spend** | Sum of amount on non-void entries — the base measure | `entries` |
| **Billed total** | The bill's own total, confirmed by a person. Compare against spend; the gap is a finding | `document_extraction` |
| **Budget & variance** | Approved, utilised, balance — dated by `as_of`, so revisions are a time series, not a single figure | budget allocation, 3 levels |
| **Unit rate** | Net rate per normalised unit, per vendor, per date. The benchmarkable measure | `rate_reference` |
| **Quantity** | How much was actually bought, in a comparable unit | line item · `rate_reference` |
| **Discount** | Percentage off list, per line, per vendor | line item |
| **Tax charged** | CGST / SGST / IGST breakdown and round-off, per bill | `tax_breakdown_verified` |
| **Amount at risk** | Rupees attached to an open exception or analytic flag | `reconciliation_exception` · `flags` |
| **Entry count** | Volume — the denominator behind every average, and a finding on its own when it diverges from spend | `entries` |

### Readiness key

Used on every report in the catalogue:

| Marker | Meaning |
|---|---|
| **READY** | Data and a view already exist |
| **VIEW** | Data exists; one SQL view is needed |
| **INPUT** | Needs something the system does not yet hold — see [section 7](#7-what-the-data-cannot-tell-you-yet) |

---

## 3. Report catalogue

### Family A — Budget & spend

Department, sub-department, administrative head, budget head, category, zone. What is mostly
missing today is not the totals — it is *comparison*: against budget over time, against pace,
against last year, and against each other.

| ID | Report | The question | Status |
|---|---|---|---|
| **A-01** | Budget vs actual, three levels | Budget head, department and sub-department — spend against the approved figure, with a proper "no budget set" state rather than a misleading −100%. | READY |
| **A-02** | Budget revision history | Allocations are dated, so the history is already recorded: original ask → approved → each revision → today, as a waterfall. Shows who kept coming back for more. | VIEW |
| **A-03** | Burn rate & landing forecast | At the current run rate, against the event's known end date — where does each department land? "Projects to 118% of budget" beats "is at 71% today". | VIEW |
| **A-04** | Administrative head accountability | Spend, entry volume and budget adherence per named head. The dimension exists and is currently almost unreported — yet it is the one that attaches a number to a person. | VIEW |
| **A-05** | Zone cost map | Spend across the 13 sites. Deserves a treemap or a site plan, not a bar list — the relative areas *are* the message. | READY |
| **A-06** | Zone × category matrix | What each site spends on. Reveals sites whose mix is unlike every comparable site. | VIEW |
| **A-07** | Budget category mix | Where money goes structurally, expressed as share rather than total — so it stays readable as the total grows. | READY |
| **A-08** | Entry-type split by department | Invoice vs reimbursement vs advance vs invoice-against-uplaq. A high reimbursement share is itself a control signal. | READY |
| **A-09** | Outstanding advance ageing | Advances issued but never settled — the settlement link is null on the invoice side. Live cash exposure, bucketed by age and owner. | VIEW |
| **A-10** | Reimbursement profile | Who is reimbursed, how often, how much, and for what type. Reimbursements bypass the normal vendor path, so they deserve their own view. | VIEW |
| **A-11** | Spend curve & peak weeks | Weekly spend across the event with the peak marked. Tells you when the pressure lands — and therefore when to staff for it next year. | VIEW |
| **A-12** | Event-over-event comparison | Same department, same category, 1448 vs 1449, indexed to a common base. Every table already carries the event, so this costs nothing to build — it only waits on a second year. | INPUT |

### Family B — Vendors

Vendors are alias-merged and normalised, which means concentration, dependency and
relationship analysis all actually work — they collapse to a real supplier rather than
fragmenting across seven spellings of the same name.

| ID | Report | The question | Status |
|---|---|---|---|
| **B-01** | Concentration curve *(flagship)* | Cumulative share of spend as vendors are added, ranked. Produces one sentence leadership acts on: "62% of spend sits with 8 of 140 vendors." | VIEW |
| **B-02** | Vendor scorecard | One card per vendor: spend, share, price against our benchmark, discount given, document quality, GSTIN validity, flag history. A supplier rating you could put in front of the supplier. | VIEW |
| **B-03** | Department dependency | Which departments rely on a single vendor for more than half their spend. Single-source risk, named. | VIEW |
| **B-04** | Vendor exclusivity | Vendors serving exactly one department, especially at high value. Not wrong in itself — but it is where a relationship, rather than a market, is setting the price. | VIEW |
| **B-05** | New vendor, first bill | Vendors first seen mid-event, ranked by the size of their opening invoice. A new vendor whose first bill is also their largest deserves a look. | VIEW |
| **B-06** | Price ranking per item family | For each item we buy repeatedly: who charges what, ranked. Turns purchasing from a habit into a choice. | VIEW |
| **B-07** | Related-party cluster map | Distinct vendor names sharing a GSTIN, phone number or address. Best drawn as a network — the shape *is* the finding, and a table hides it. | READY |
| **B-08** | GSTIN validity & tax exposure | Tax charged, against the share of it where the vendor GSTIN passes checksum and our own GSTIN appears on the bill. The gap is credit that may not be claimable. | VIEW |
| **B-09** | Activity span & dormancy | First and last invoice per vendor, and the gaps. Surfaces vendors that appear once for a large amount and are never seen again. | VIEW |

### Family C — What we bought

The line-item family. This is the part no conventional expense report can produce, and it is
where the money findings are — because a rate is comparable in a way that an invoice total
never is.

| ID | Report | The question | Status |
|---|---|---|---|
| **C-01** | Spend by item family | What we actually bought, in rupees — the answer no ledger view can give. | READY |
| **C-02** | Purchase tree *(flagship)* | Item family → catalogue item → vendor → the specific bills, drillable at every level. The exploration surface for "where did ₹X actually go". | VIEW |
| **C-03** | Rate benchmark | Median, minimum and maximum net rate per item family and unit, with the number of observations behind each — so a benchmark built on three data points is visibly weaker than one built on forty. | READY |
| **C-04** | Above-median overpayment *(flagship)* | For every line priced above our own median for that item and unit: (rate − median) × quantity. Summed, that is a headline rupee figure benchmarked against our own purchase history — very hard to argue with. | VIEW |
| **C-05** | Rate drift across the event | Same vendor, same item, price movement week by week. Detects mid-event escalation while there is still time to act. | VIEW |
| **C-06** | Discount consistency | The same vendor giving different discounts to different departments on the same item family. | VIEW |
| **C-07** | Quantity purchased by unit | Not rupees — sqft, nos, days. Consumption in physical terms, which is what an operations head actually plans against. | VIEW |
| **C-08** | Unit economics by zone | Rate paid for the same item at different sites. Two zones buying the same ceiling at different rates is a finding no total will ever show. | VIEW |
| **C-09** | Instrument-type mix *(flagship)* | How much spend is backed by a proper tax invoice versus a letterhead bill, a cash memo, or a quotation. "₹X of spend is supported only by a letterhead bill" ends a meeting quickly. | VIEW |
| **C-10** | HSN coverage & GST anomaly | Which bills carry an HSN or SAC code, and where the tax charged departs from the rate that code implies. | INPUT |

> **A dependency worth knowing before you promise C-03 and C-04.**
> Rate comparison only works where two or more vendors have supplied the *same* item family in
> the *same* unit. The schema notes that against the early corpus there was very little such
> overlap. These two reports get stronger as the item catalogue is confirmed and the corpus
> grows — so build them early, show the observation count on the face of every benchmark, and
> let coverage improve over the event rather than waiting for it.

### Family D — Entry integrity

The controls already run and already attach rupees to what they find. What is missing is the
reporting layer that turns 23 exception types and 14 flag types into a short list of statements
someone can act on.

| ID | Report | The question | Status |
|---|---|---|---|
| **D-01** | Exception heat map *(flagship)* | Exception type down, department across, cell shaded by rupees at risk. One glance separates the expensive break from the merely noisy one. | VIEW |
| **D-02** | Amount-at-risk waterfall | Total spend → flagged → confirmed → recovered or dismissed. The value the review function actually delivered, in one figure. | VIEW |
| **D-03** | Open item ageing | Exceptions and flags by days open and severity, with the owning department. Names the queue being sat on. | VIEW |
| **D-04** | Duplicate payment register | The same bill paid twice — matched by document hash, and by vendor plus invoice number plus amount. Reported as rupees prevented. | READY |
| **D-05** | Ledger vs bill reconciliation | Distribution of the gap between the entry amount and the bill's own total. Most sit at zero; the tail is the report. Top 20 by rupee value. | VIEW |
| **D-06** | Entries with no supporting bill | Not a count — a rupee figure, by department and by vendor. This is the size of the undocumented pile. | VIEW |
| **D-07** | Benford's Law digit test | Leading-digit distribution of all amounts against the expected curve. A standard forensic test that needs no new data and reads as rigorous to any auditor or trustee. | VIEW |
| **D-08** | Round-number bias | Share of amounts ending in 000, by department and vendor. A high share means estimates are being booked as invoices. | VIEW |
| **D-09** | Threshold splitting | Histogram of invoice amounts. A spike just below an approval limit is deliberate splitting — but the limits have to be recorded first. | INPUT |

### Family E — Executive framings

No new data — these arrange existing measures into the shapes a decision-maker can act on in
under a minute. These are the ones to build for the presentation.

| ID | Report | The question | Status |
|---|---|---|---|
| **E-01** | Department league table *(flagship)* | One row per department: budget adherence, projected landing, spend share, documentation coverage, rupees at risk — ranked. Ranking departments changes behaviour in a way that reporting totals never does. | VIEW |
| **E-02** | Attention map | Departments plotted as spend against documentation strength. The high-spend, weakly-documented quadrant is the answer to "where do we look first", and it needs no caption. | VIEW |
| **E-03** | Vendor risk board | The top vendors by spend, each with concentration, price position, document quality and open flags on one line. | VIEW |
| **E-04** | Weekly digest | The ten things most worth attention this week, ranked by rupees, each written as a plain sentence with an owner. The only report a busy person reads end to end. | VIEW |
| **E-05** | Rupee provenance trace | Pick any rupee and follow it live: budget head → allocation → entry → the bill image → the line item → the item family → the benchmark. This is the demo that wins the meeting. | VIEW |

---

## 4. Six flagships, worked through

If only six get built, build these. Each produces a number that is defensible, surprising and
actionable — the three properties that let a report survive contact with a senior audience.

| Flagship | Chart form | Why this form |
|---|---|---|
| **C-04** Above-median overpayment | Strip plot — one dot per purchase on a rate axis, one row per item family, our own median as a vertical rule, the above-median region shaded | The spread *is* the argument. A tight cluster means the market is priced; a long right tail means someone is paying more than we do elsewhere for the same thing. |
| **B-01** Concentration curve | Single line — vendors ranked along the bottom, cumulative share of spend up the side, with an even-spend reference line | Deliberately **not** a classic Pareto. Two scales on one chart is the single most common way a finance chart misleads. |
| **C-09** Instrument-type mix | Stacked bar per department, split by document kind, measured in rupees not counts | Turns a compliance question into a money question. |
| **C-02** Purchase tree | Drillable tree: family → item → vendor → bill | The only view in the product that answers "what did we actually buy", and the natural home for a live drill-down demo. |
| **D-01** Exception heat map | Matrix — type down, department across, shaded by rupees at risk | Sequential single-hue shading, never a rainbow, so darker always and only means more. |
| **E-01** Department league table | Ranked table, five columns, every cell a link into the filtered entries behind it | Colour only on the outliers, so the outliers are what you see. |

### C-04 in detail

For each item family, plot every purchase as a dot on a rate axis, with our own median marked.
Everything to the right of the median has a rupee cost: the excess rate multiplied by the
quantity bought. **The dots are the evidence; the total is the headline.**

Read it as: one dot = one purchase · vertical line = our own median · shaded band = above
median, and therefore costed.

### B-01 in detail

Vendors ranked by spend along the bottom, cumulative share of total spend up the side. The
steeper the opening, the more dependent we are on a handful of suppliers. One axis, one line,
one sentence underneath. The gap between the actual curve and the straight "if spend were even"
reference line is the concentration.

---

## 5. Screen architecture

Today the reports page is a single file carrying about fourteen sections, each a heading, a bar
list, a table and a CSV button. Every section has the same visual weight, so nothing is a
headline and the reader must do the prioritising. That is an export tool, not a dashboard. The
fix is not more charts — it is **separating the audiences**.

| Surface | Audience and job | Carries |
|---|---|---|
| **Executive Brief** | Trustees and senior administration. One screen, printable, projectable. Answers "is this under control" in thirty seconds. | E-01, E-02, E-04, A-03, C-04 |
| **Budget & Spend** | Department and administrative heads. Where the money went, and where it is heading. | A-01 … A-12 |
| **Vendors & Purchases** | Procurement. Who we buy from, what we buy, and at what rate. | B-01 … B-09, C-01 … C-10 |
| **Integrity** | The review function. What does not add up. | D-01 … D-09 |
| **Explore** | Anyone with a specific question. The current page, kept — but reframed as a pivot and drill workspace rather than the front door. | all views + CSV |

### Executive Brief — proposed layout

Composed so it reads top to bottom as an argument: *here is the position, here is what moved,
here is where to look, here is what needs you.*

| Band | Contents |
|---|---|
| **1 · KPI row** (5 tiles) | Spend vs budget · Projected landing · Vendor concentration · Above-median spend · Open ₹ at risk. Each tile: value, delta vs last period, sparkline. |
| **2 · What changed this week** | Three to five plain sentences generated from the same queries that feed the tiles. Not a chart. This is the part that gets read aloud in the meeting. |
| **3 · Two charts** | E-02 Attention map (departments by spend against documentation strength, click to drill) alongside A-03 Burn rate vs pace with the projected landing marked. |
| **4 · Two panels** | E-01 Department league table (ranked, drillable, colour only on outliers) alongside E-04 "Needs your decision" — ten items ranked by rupees, each with an owner and an age. Not "open exceptions: 214". |
| **5 · Footer** | Event selector · period comparison · Present mode · export the whole brief as one PDF or workbook. |

### Two cheap features with outsized effect

**Present mode** — a full-screen, large-type, no-navigation rendering of the Brief for a
projector. It is a stylesheet and a keyboard shortcut, and it is the difference between showing
someone a web app and showing them a report.

**The board pack** — the same Brief rendered to a single PDF and a matching workbook, on a
schedule. Since the outward integration is deliberately spreadsheet-based, a periodic report in
exactly that idiom will be circulated far more widely than any URL.

---

## 6. Design fixes, in priority order

The existing maroon-and-gold palette, the chart primitives and the empty states are good and
stay. These are the changes that move the page from competent to persuasive.

| # | Change | Why it matters |
|---|---|---|
| 1 | **Give every number a comparison.** No tile ships without a delta against the prior period or the prior event, plus its sparkline. | An isolated number is uninterpretable. "₹4.2 Cr" means nothing; "₹4.2 Cr, up 18% on last week" means something. Highest-value single change on the page, and it needs no new views. |
| 2 | **Break the equal-weight stack.** A hero band, then a two-column chart grid, then detail tables behind a disclosure. | Fourteen sections of identical weight force the reader to prioritise. Hierarchy is the product telling them what matters. |
| 3 | **Write one sentence under every chart, computed from its own data.** "Three departments are above 90% of budget with six weeks remaining." | Most viewers read the sentence and not the chart. Make the sentence true and specific and you have communicated regardless. |
| 4 | **Make every figure a link.** Each bar, cell and total drills to the filtered entry list behind it. | Trust in a dashboard comes from being able to reach the rows. Partly present already — make it universal. |
| 5 | **Separate brand colour from status colour.** Maroon and gold stay as identity; good, warning and critical get a reserved palette, never reused as a series, always paired with an icon and a label. | Colour that means two things at once means neither — and it breaks for colour-blind readers and in print. |
| 6 | **Encode state in shape, not only in text.** A severity stripe on the row edge, a pill for status, an inline bar for share of budget used. | A dashboard is scanned, not read. State has to survive peripheral vision. |
| 7 | **Fix the tables as tables.** Sticky headers, tabular figures, right-aligned money, fixed decimals, compact rupee formatting above a lakh. | Financial tables are read down the column. Misaligned digits cost more comprehension than any missing chart. |
| 8 | **Never put two scales on one chart.** Rupees and percentages get two charts, small multiples, or a common index. | Dual axes let the author choose the story by choosing the scales. It is the fastest way to lose an audience that knows what it is looking at. |
| 9 | **Move the event selector and period comparison into the shell.** Global, sticky, always visible. | Every figure is scoped by it. If the scope is not visible the numbers are ambiguous — and an ambiguous number in front of leadership is worse than no number. |
| 10 | **Split the reports page into per-section server components.** One loader and one presenter each, composed by a thin route. | Fourteen sections in one file means every change risks all fourteen, and one slow query blocks the whole page. Separate components stream and fail independently. |

---

## 7. What the data cannot tell you yet

Six inputs unlock reports that are otherwise impossible. Each is small — a lookup table or a
single column — and each has a named report waiting on it.

| Missing input | Unlocks | Effort |
|---|---|---|
| **Approval thresholds** — the rupee limits at which sign-off escalates | D-09 threshold splitting | One small table |
| **HSN / SAC → expected GST rate** | C-10 tax anomaly | Public dataset, one import |
| **Zone capacity or people served** | A-05 cost per head per site — the fairness question, which totals alone can never settle | One column on the zone table |
| **Vendor PAN and supplier category** | B-02 scorecard depth, spend by supplier category, TDS applicability | Two columns on the vendor table |
| **Prior-event data** — 1447 and earlier | A-12 and every year-on-year comparison | Historic import; the schema is already event-scoped and ready |
| **Confirmed item catalogue coverage** | C-03 and C-04 — benchmarks only work where two vendors supplied the same family in the same unit | Ongoing curation, not a build |

> **Name this explicitly on screen.** The entry amount and the bill's own total are two
> different measures, and only part of the corpus has a verified bill behind it. Any report
> that mixes them must say which it is using, on the face of the chart. Getting that wrong once
> in front of leadership costs more credibility than the whole dashboard earns.

---

## 8. Build sequence

Ordered so something presentable exists early, and so each phase reuses the views built by the
one before.

| Phase | Ships | Result |
|---|---|---|
| **One** | Period comparison in the shell; deltas and sparklines on every existing tile; a computed sentence under each existing chart; table typography fixed. | The current page becomes readable and interpretable without a single new query. |
| **Two** | Views for E-01, E-02, A-03 and A-04. Build the Executive Brief on top of them. Add Present mode. | The presentable artefact exists. This is the demo. |
| **Three** | Split the page into the five surfaces; move existing sections into Budget, Vendors & Purchases and Integrity; keep Explore as the drill workspace. | Each audience gets a front door. Page weight and query time drop. |
| **Four** | The money-finding reports: C-04, C-09, B-01, D-01, D-02. | The dashboard starts producing findings, not just descriptions. |
| **Five** | The rest of the line-item family (C-02, C-05 … C-08) and the vendor family (B-02 … B-09). | Procurement gets a real analytical surface — the part no comparable system has. |
| **Six** | Forensics (D-05 … D-08), then E-04 and E-05. Then the scheduled board pack, and the section 7 inputs in the order their reports are wanted. | The reporting circulates on its own, in the format this organisation already reads. |

---

*Prepared against the live schema — the migration history, the reporting and analytics views,
and the current reports implementation. Report IDs are stable; use them to commission any item
in this catalogue.*
