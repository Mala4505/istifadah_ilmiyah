-- reporting-blueprint.md §7 "What the data cannot tell you yet" -- the small
-- reference inputs that unlock reports otherwise impossible. This migration is
-- PURE DDL + seed data for the reference lookups; the report views that read
-- them ship separately (20260903000020_hsn_gst_anomaly_view.sql) so this file
-- can be reasoned about as "just the tables".
--
-- Four inputs, one per blueprint §7 row that is a table or a column:
--
--   1. approval_threshold   -- D-09 threshold splitting. "The rupee limits at
--      which sign-off escalates." SEEDED WITH NOTHING ON PURPOSE: the
--      organisation has confirmed (lib/analytics/thresholds.ts APPROVAL_LIMIT,
--      "NULL, confirmed with the user 2026-08-12: no formal limit exists")
--      that there is no delegated financial authority limit today. This table
--      is the place an admin records one if it is ever introduced; until then
--      D-09 runs in histogram-only mode and says so on screen.
--
--   2. hsn_gst_rate         -- C-10 HSN/SAC tax anomaly. "HSN / SAC -> expected
--      GST rate." Seeded with a conservative STARTER set (~55 rows) covering
--      the codes this org's spend plausibly touches -- construction & works
--      contracts, building materials, furniture, electrical, plumbing/sanitary,
--      hardware, paint, glass, printing, event furnishing textiles, packaged
--      food & beverage for events, transport, and professional services.
--      Slab logic is cited inline below. An admin curates this further from the
--      public CBIC rate schedule; the C-10 coverage half works with zero rows,
--      the anomaly half activates once rows exist.
--
--   3. zone.people_served   -- A-05 cost per head per site. One nullable int
--      column, admin-populated. "The fairness question, which totals alone can
--      never settle."
--
--   4. vendor.pan + vendor.supplier_category -- B-02 scorecard depth, spend by
--      supplier category, TDS applicability. Two nullable text columns,
--      admin/enrichment-populated. The reports that consume them are not built
--      here; this migration only adds the columns so enrichment can begin.
--
-- RLS on the two new tables follows 20260811000002_budget_category exactly:
-- staff-wide read (private.is_staff()), admin-only write (private.is_admin()),
-- enable + force row level security, explicit policies, explicit grants
-- (every table added after 20260808000026's blanket grant needs its own).
-- The two ALTER TABLE statements add nullable columns only and change no
-- policy -- zone and vendor keep the RLS they already have.

-- ===========================================================================
-- 1. approval_threshold  (D-09) -- SEED NOTHING
-- ===========================================================================
-- One row = "at or above min_amount, sign-off escalates to escalates_to",
-- optionally scoped to one department (department_id null = an org-wide rule).
-- effective_from lets a limit be revised without losing the prior figure
-- (append a new row; the reports read the latest effective row per scope).
create table public.approval_threshold (
  id bigint generated always as identity primary key,
  department_id bigint references public.department(id),  -- null = org-wide
  min_amount numeric(14,2) not null,
  escalates_to text not null,                             -- free label, e.g. 'Trustee board'
  effective_from date not null default current_date,
  note text,
  created_at timestamptz not null default now()
);
create index approval_threshold_department_idx on public.approval_threshold (department_id)
  where department_id is not null;

comment on table public.approval_threshold is
  'reporting-blueprint.md §7 / D-09. Rupee limits at which purchase sign-off '
  'escalates. Intentionally EMPTY on creation: the organisation confirmed '
  '(2026-08-12) it operates no formal delegated-authority limit today -- see '
  'lib/analytics/thresholds.ts APPROVAL_LIMIT. An admin adds rows here if a '
  'limit is introduced; D-09 threshold-splitting detection activates then.';

alter table public.approval_threshold enable row level security;
alter table public.approval_threshold force row level security;

-- Same shape as budget_category's policies (20260811000002): staff-wide read,
-- admin-only insert/update/delete. Rows are curated by an admin from the org's
-- own governance decisions, so an authenticated insert policy, not import-only.
create policy approval_threshold_select on public.approval_threshold for select to authenticated
  using ((select private.is_staff()));
create policy approval_threshold_insert_admin on public.approval_threshold for insert to authenticated
  with check ((select private.is_admin()));
create policy approval_threshold_update_admin on public.approval_threshold for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
create policy approval_threshold_delete_admin on public.approval_threshold for delete to authenticated
  using ((select private.is_admin()));

grant select, insert, update, delete on public.approval_threshold to authenticated;
grant usage, select on sequence public.approval_threshold_id_seq to authenticated;

-- ===========================================================================
-- 2. hsn_gst_rate  (C-10) -- SEEDED starter set
-- ===========================================================================
-- code = the bare HSN (goods) or SAC (services) digits, no dots/spaces. A bill
-- line's printed code is matched by longest-prefix against this table
-- (v_hsn_gst_anomaly), so a 4-digit heading here matches every 6/8-digit code
-- beneath it unless a more specific row is present.
create table public.hsn_gst_rate (
  code text primary key,
  kind text not null check (kind in ('HSN','SAC')),
  description text not null,
  gst_rate numeric(4,1) not null,                 -- percent, e.g. 18.0
  effective_from date not null default '2025-07-01',
  note text,
  created_at timestamptz not null default now()
);

comment on table public.hsn_gst_rate is
  'reporting-blueprint.md §7 / C-10. HSN/SAC code -> expected total GST rate '
  '(CGST+SGST or IGST combined), percent. Seeded with a conservative starter '
  'set for this org''s spend profile; an admin curates it against the CBIC '
  'rate schedule. Matched longest-prefix against a bill line''s printed code.';

alter table public.hsn_gst_rate enable row level security;
alter table public.hsn_gst_rate force row level security;

create policy hsn_gst_rate_select on public.hsn_gst_rate for select to authenticated
  using ((select private.is_staff()));
create policy hsn_gst_rate_insert_admin on public.hsn_gst_rate for insert to authenticated
  with check ((select private.is_admin()));
create policy hsn_gst_rate_update_admin on public.hsn_gst_rate for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
create policy hsn_gst_rate_delete_admin on public.hsn_gst_rate for delete to authenticated
  using ((select private.is_admin()));

grant select, insert, update, delete on public.hsn_gst_rate to authenticated;
-- No sequence grant: the PK is the natural code, not an identity column.

-- ---------------------------------------------------------------------------
-- Seed. Slab logic (FY 2025-26 CBIC schedule, conservative reading):
--   * 18% is the default for works contracts, manufactured building inputs
--     (steel, aluminium, wire, fittings, hardware, paint, plywood, glass),
--     furniture, and virtually every professional / installation / event
--     service. When unsure between 12 and 18 for a manufactured good, 18.
--   * 28% only for the demerit / luxury handful the org actually buys:
--     cement, air-conditioners, aerated drinks.
--   * 12% for tents/tarpaulins, carpets and furnishing textiles, and most
--     paper.
--   *  5% for raw/primary construction materials (sand, aggregate, natural
--     stone, building bricks), basic unbranded foodstuffs bought for events,
--     domestic LPG, and goods transport.
--   *  0% only for printed books.
-- Every row an admin should re-confirm before leaning on a C-10 finding; the
-- note column flags the ones most likely to move on curation.
-- ---------------------------------------------------------------------------
insert into public.hsn_gst_rate (code, kind, description, gst_rate, note) values
  -- Raw construction materials (5%)
  ('2505', 'HSN', 'Natural sand', 5.0, null),
  ('2517', 'HSN', 'Pebbles, gravel, crushed stone aggregate', 5.0, null),
  ('2516', 'HSN', 'Granite, sandstone and other monumental/building stone', 5.0, null),
  ('6901', 'HSN', 'Building bricks (non-fly-ash)', 5.0, 'Fly-ash blocks sit at 12% -- add a 6815 row if used'),
  ('2523', 'HSN', 'Portland cement, clinker', 28.0, null),
  -- Structural / finishing building inputs (18%)
  ('7214', 'HSN', 'Iron/non-alloy steel bars and rods', 18.0, null),
  ('7308', 'HSN', 'Structural steel: doors, windows, frames, columns', 18.0, null),
  ('7610', 'HSN', 'Aluminium structures, doors, windows and frames', 18.0, null),
  ('3208', 'HSN', 'Paints and varnishes (synthetic polymer base)', 18.0, null),
  ('3209', 'HSN', 'Paints and varnishes (water-based)', 18.0, null),
  ('3214', 'HSN', 'Glaziers'' putty, fillers, sealants', 18.0, null),
  ('4412', 'HSN', 'Plywood, veneered panels', 18.0, null),
  ('4410', 'HSN', 'Particle board, OSB and similar wood board', 18.0, null),
  ('6810', 'HSN', 'Articles of cement/concrete (blocks, pipes, tiles)', 18.0, null),
  ('3925', 'HSN', 'Builders'' plasticware: doors, shutters, panels', 18.0, null),
  ('3917', 'HSN', 'Plastic tubes, pipes and fittings (PVC/CPVC)', 18.0, null),
  ('7005', 'HSN', 'Float glass and surface-ground glass in sheets', 18.0, null),
  ('7007', 'HSN', 'Safety glass (toughened / laminated)', 18.0, null),
  ('7009', 'HSN', 'Glass mirrors', 18.0, null),
  ('6907', 'HSN', 'Ceramic flags and paving, hearth or wall tiles', 18.0, null),
  ('6910', 'HSN', 'Ceramic sinks, wash basins, WC pans, cisterns', 18.0, null),
  -- Hardware / fittings / tools (18%)
  ('7318', 'HSN', 'Screws, bolts, nuts, washers and similar iron/steel articles', 18.0, null),
  ('8301', 'HSN', 'Padlocks and locks, keys, of base metal', 18.0, null),
  ('8302', 'HSN', 'Base-metal mountings, fittings, hinges, brackets', 18.0, null),
  ('8205', 'HSN', 'Hand tools not elsewhere specified', 18.0, null),
  ('8481', 'HSN', 'Taps, cocks, valves for pipes and tanks', 18.0, null),
  -- Electrical (18%, AC at 28%)
  ('8544', 'HSN', 'Insulated wire and cable', 18.0, null),
  ('8536', 'HSN', 'Switches, sockets, breakers for <=1000V', 18.0, null),
  ('8537', 'HSN', 'Boards, panels, consoles for electric control', 18.0, null),
  ('9405', 'HSN', 'Luminaires and lighting fittings, LED lamps', 18.0, null),
  ('8414', 'HSN', 'Fans, blowers, ventilating hoods', 18.0, null),
  ('8504', 'HSN', 'Electrical transformers, static converters, ballasts', 18.0, null),
  ('8502', 'HSN', 'Electric generating sets and rotary converters', 18.0, null),
  ('8415', 'HSN', 'Air conditioning machines', 28.0, null),
  -- Furniture and furnishing (18% goods; textiles 12%)
  ('9401', 'HSN', 'Seats and chairs, and parts', 18.0, null),
  ('9403', 'HSN', 'Other furniture (tables, cupboards, racks) and parts', 18.0, null),
  ('9404', 'HSN', 'Mattress supports, mattresses, cushions', 18.0, null),
  ('5702', 'HSN', 'Woven carpets and floor coverings', 12.0, null),
  ('5703', 'HSN', 'Tufted carpets and floor coverings', 12.0, null),
  ('6302', 'HSN', 'Bed linen, table linen, toilet and kitchen linen', 12.0, null),
  ('6303', 'HSN', 'Curtains, blinds, valances', 12.0, null),
  ('6306', 'HSN', 'Tarpaulins, awnings, tents, sails', 12.0, null),
  -- Printing and stationery
  ('4901', 'HSN', 'Printed books, booklets and similar printed matter', 0.0, null),
  ('4909', 'HSN', 'Printed cards, invitations, greeting cards', 18.0, null),
  ('4910', 'HSN', 'Calendars of any kind, printed', 18.0, null),
  ('4911', 'HSN', 'Other printed matter: brochures, posters, flex banners', 18.0, null),
  ('4820', 'HSN', 'Registers, account books, notebooks, binders', 18.0, 'Exercise books specifically are 12%'),
  ('4802', 'HSN', 'Uncoated paper for writing/printing', 12.0, null),
  ('9608', 'HSN', 'Pens, ballpoint pens, markers', 18.0, null),
  -- Event food & beverage (goods)
  ('2201', 'HSN', 'Waters, natural or artificial mineral, not sweetened', 18.0, 'Bulk drinking water supply can be exempt -- verify per bill'),
  ('2202', 'HSN', 'Sweetened / flavoured / aerated beverages', 28.0, null),
  ('2106', 'HSN', 'Food preparations not elsewhere specified (namkeen, mixes)', 12.0, null),
  ('1905', 'HSN', 'Bread, pastry, cakes, biscuits, rusks', 18.0, 'Plain bread is exempt; branded/packaged bakery 18%'),
  ('0902', 'HSN', 'Tea', 5.0, null),
  ('1701', 'HSN', 'Cane or beet sugar', 5.0, null),
  ('2711', 'HSN', 'Petroleum gases -- LPG for domestic/community supply', 5.0, 'Commercial/bulk LPG is 18%'),
  ('3923', 'HSN', 'Plastic articles for conveyance/packing of goods', 18.0, null),
  ('4823', 'HSN', 'Paper tableware: plates, cups, trays', 18.0, null),
  ('3924', 'HSN', 'Plastic tableware, kitchenware, household articles', 18.0, null),
  -- Cleaning / consumables
  ('3401', 'HSN', 'Soap and organic surface-active products', 18.0, null),
  ('3402', 'HSN', 'Detergents and cleaning preparations', 18.0, null),
  -- Services (SAC)
  ('9954',   'SAC', 'Construction services (buildings and works contracts)', 18.0, null),
  ('995461', 'SAC', 'Electrical installation services', 18.0, null),
  ('995462', 'SAC', 'Water plumbing and drain-laying services', 18.0, null),
  ('995473', 'SAC', 'Painting services', 18.0, null),
  ('9963',   'SAC', 'Accommodation, food and beverage services', 5.0, 'Standalone/outdoor catering is 5% without ITC; hotel-attached banqueting 18%'),
  ('996334', 'SAC', 'Catering in exhibition/event/function premises', 18.0, null),
  ('998553', 'SAC', 'Reservation services for event tickets / conventions', 18.0, null),
  ('998596', 'SAC', 'Events, exhibitions and convention organisation services', 18.0, null),
  ('9973',   'SAC', 'Leasing or rental services without operator', 18.0, null),
  ('997212', 'SAC', 'Rental or leasing of non-residential property', 18.0, null),
  ('996511', 'SAC', 'Road transport of goods', 5.0, 'GTA under forward charge with ITC is 12%'),
  ('996601', 'SAC', 'Rental of road vehicles with operator', 18.0, null),
  ('9983',   'SAC', 'Other professional, technical and business services', 18.0, null),
  ('998221', 'SAC', 'Accounting and bookkeeping services', 18.0, null),
  ('998222', 'SAC', 'Auditing and tax consultancy services', 18.0, null),
  ('998311', 'SAC', 'Management consulting services', 18.0, null),
  ('998313', 'SAC', 'Information technology consulting and support services', 18.0, null),
  ('998363', 'SAC', 'Sale of advertising space or time', 18.0, null),
  ('998719', 'SAC', 'Maintenance and repair of other machinery/equipment', 18.0, null),
  ('995429', 'SAC', 'Works contract and related services for civil engineering', 18.0, null);

-- ===========================================================================
-- 3. zone.people_served  (A-05)
-- ===========================================================================
alter table public.zone
  add column people_served int;

comment on column public.zone.people_served is
  'reporting-blueprint.md §7 / A-05. Headcount or capacity this zone/site '
  'serves, admin-populated. Nullable: null means "not yet recorded", and '
  'A-05 cost-per-head simply omits that zone rather than dividing by zero.';

-- ===========================================================================
-- 4. vendor.pan + vendor.supplier_category  (B-02, TDS)
-- ===========================================================================
alter table public.vendor
  add column pan text,
  add column supplier_category text;

comment on column public.vendor.pan is
  'reporting-blueprint.md §7. Vendor PAN, admin/enrichment-populated. Enables '
  'TDS applicability (194C individual-vs-other rate) and PAN-GSTIN consistency '
  'checks. Nullable; not validated at the column level.';
comment on column public.vendor.supplier_category is
  'reporting-blueprint.md §7 / B-02. Free-text supplier category (e.g. '
  '"works contractor", "furniture", "printing", "professional services"), '
  'admin/enrichment-populated. Enables spend-by-supplier-category reporting.';
