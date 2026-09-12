-- Per-vendor line-item template: a saved, ordered list of line-item
-- descriptions for a vendor whose bills repeat the same fixed items (e.g.
-- handwritten bills where OCR guesses the description fresh, and wrong,
-- every time). Seeded once from an already-reviewed bill; applied client-side
-- in the review screen to prefill `description` on future bills from that
-- vendor, while quantity/rate/amount always stay live from OCR (see
-- components/review/review-workspace.tsx's applyLineItemTemplate).
--
-- `use_line_item_template` rides on vendor's existing RLS update policy
-- (vendor_update_admin, 20260808000026) -- no new policy needed for it.
alter table public.vendor add column use_line_item_template boolean not null default false;

create table public.vendor_line_item_template (
  id bigint generated always as identity primary key,
  vendor_id bigint not null references public.vendor(id) on delete cascade,
  line_order int not null,
  description text not null,
  created_at timestamptz not null default now(),
  unique (vendor_id, line_order)
);
create index vendor_line_item_template_vendor_idx on public.vendor_line_item_template (vendor_id);

alter table public.vendor_line_item_template enable row level security;
alter table public.vendor_line_item_template force row level security;

-- Same shape as vendor_update_admin (20260808000026): staff-wide read, since
-- the review screen needs to read a vendor's template regardless of the
-- reviewer's role; writes (seed/edit/reorder/remove) are an admin decision,
-- same posture as renaming or merging a vendor identity (§3.2).
create policy vendor_line_item_template_select on public.vendor_line_item_template for select to authenticated
  using ((select private.is_staff()));

create policy vendor_line_item_template_write_admin on public.vendor_line_item_template
  for all to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
