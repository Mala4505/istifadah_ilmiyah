-- Phase 3 (plan §2.1): per-user keyboard shortcut configuration.
-- Self-writable under the existing staff_profile_update RLS policy
-- (20260819000003_role_rbac_v2.sql) -- these columns are not in the
-- role/is_active locked-fields set, so no new policy is needed.

alter table public.staff_profile
  add column keymap_overrides jsonb not null default '{}'::jsonb,
  add column shortcuts_enabled boolean not null default true;

comment on column public.staff_profile.keymap_overrides is
  'Per-user overrides of default /review keyboard shortcut bindings, keyed by action id. '
  'Shape: { [actionId]: { key: string, alt?: boolean, shift?: boolean, ctrl?: boolean, meta?: boolean } }. '
  'See lib/shortcuts/config.ts for the action list and defaults.';

comment on column public.staff_profile.shortcuts_enabled is
  'Master enable/disable for keyboard shortcuts on the /review screen.';
