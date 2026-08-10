-- ITS-number login (new requirement, post §10). Login is now ITS number +
-- password, not email + password. Supabase Auth still owns every credential,
-- JWT, and refresh token unchanged: the app derives a deterministic synthetic
-- address `<its_number>@<ITS_LOGIN_EMAIL_DOMAIN>` (lib/auth/its.ts) and stores
-- THAT as auth.users.email, which is Supabase's login handle only and is
-- never shown to anyone. its_number here is the human-facing identifier and
-- the thing admins type when provisioning an account; contact_email is the
-- real address, used for notifications, never for login.
alter table public.staff_profile
  add column its_number text,
  add column contact_email text;

-- Nullable, not not-null: the pre-existing self-signup trigger fallback path
-- (see private.handle_new_user below) can still land a row with no
-- its_number if auth.users is ever populated out of band (Supabase
-- dashboard, support tooling). Such an account simply has no ITS-based login
-- path until an admin sets one via the admin.createUser flow.
alter table public.staff_profile
  add constraint staff_profile_its_number_format
    check (its_number is null or its_number ~ '^[0-9]{8}$');

create unique index staff_profile_its_number_key on public.staff_profile (its_number)
  where its_number is not null;

-- Admin-provisioned accounts (lib/actions/admin.ts createStaffUser) pass
-- its_number/full_name/role/department_id/is_active/contact_email through
-- auth.users.raw_user_meta_data at creation time, since admin.createUser is
-- the only path that knows them. Falls back to the original inactive/viewer
-- default (§3.8) when that metadata is absent, so an out-of-band auth.users
-- insert still lands a usable, safely-inert row instead of failing the
-- trigger outright.
create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.staff_profile (
    id, display_name, role, department_id, is_active, its_number, contact_email
  )
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    coalesce(new.raw_user_meta_data->>'role', 'viewer'),
    nullif(new.raw_user_meta_data->>'department_id', '')::bigint,
    coalesce((new.raw_user_meta_data->>'is_active')::boolean, false),
    new.raw_user_meta_data->>'its_number',
    new.raw_user_meta_data->>'contact_email'
  )
  on conflict (id) do nothing;
  return new;
end; $$;
