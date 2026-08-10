-- API usage tracking (new requirement). One row per Route Handler
-- invocation — lib/api-log.ts's withApiLogging wraps a handler and writes
-- here through the service-role admin client after every response,
-- success or failure, so this table stays independent of whichever
-- session/RLS context the request itself ran under (some routes are
-- reachable signed-out and must still be logged, e.g. a failed auth check).
create table public.api_request_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id uuid references public.staff_profile(id),
  route text not null,
  method text not null,
  status_code integer not null,
  latency_ms integer not null,
  ip inet
);

create index api_request_log_occurred_at_idx on public.api_request_log (occurred_at desc);
create index api_request_log_user_id_idx on public.api_request_log (user_id)
  where user_id is not null;

alter table public.api_request_log enable row level security;
alter table public.api_request_log force row level security;

-- Admin-only visibility (operational/security monitoring), same pattern as
-- auth_login_attempt. No write policy for authenticated: every row is
-- written by the service-role client.
create policy api_request_log_select_admin on public.api_request_log for select to authenticated
  using ((select private.is_admin()));

-- Postdates 20260808000026's blanket grant, same reasoning as
-- auth_login_attempt (20260810000002) and 20260808000028's per-view grants.
grant select on public.api_request_log to authenticated;
