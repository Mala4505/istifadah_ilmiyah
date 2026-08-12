-- staff_profile.id had no ON DELETE behavior on its FK to auth.users, so
-- deleting an auth user blocked with a foreign key violation as long as
-- their profile row existed. staff_profile is 1:1 identity data for an auth
-- user, not an independent record, so it should disappear with the account
-- it belongs to rather than requiring a manual delete first.
alter table public.staff_profile
  drop constraint staff_profile_id_fkey,
  add constraint staff_profile_id_fkey
    foreign key (id) references auth.users(id) on delete cascade;
