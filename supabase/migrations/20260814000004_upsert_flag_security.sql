-- Fixes an anon_security_definer_function_executable WARN raised by
-- `supabase db advisors` immediately after 20260814000003 was pushed.
--
-- Two separate mistakes in that migration, both worth naming:
--
-- 1. The revoke listed `public, authenticated` but not `anon`. Supabase ships
--    `alter default privileges ... grant execute on functions to anon` for the
--    public schema, which means a newly created function carries an EXPLICIT
--    grant to anon — and revoking from PUBLIC does not remove an explicit
--    per-role grant. The function was therefore reachable, unauthenticated, at
--    /rest/v1/rpc/upsert_flag.
--
-- 2. More fundamentally, it never needed SECURITY DEFINER. The only caller is
--    the flags-run worker, which connects as service_role and bypasses RLS
--    already. SECURITY DEFINER bought nothing and cost the entire escalation
--    surface: any role that could reach the function would have written flags as
--    its owner.
--
-- SECURITY INVOKER is the correct setting. Under it, a call from anon or
-- authenticated runs against public.flags with that role's own privileges and
-- hits the deny-by-default insert policy from 20260808000026; a call from
-- service_role works exactly as before.

create or replace function public.upsert_flag(
  p_flag_type text,
  p_dedup_key text,
  p_description text,
  p_severity text default 'medium',
  p_entry_id bigint default null,
  p_related_entry_ids bigint[] default null,
  p_vendor_id bigint default null,
  p_amount_at_risk numeric default null,
  p_evidence jsonb default null,
  p_detected_by_run text default null
) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare
  v_id bigint;
begin
  insert into public.flags (
    flag_type, dedup_key, description, severity, entry_id, related_entry_ids,
    vendor_id, amount_at_risk, evidence, detected_by_run, last_detected_at
  ) values (
    p_flag_type, p_dedup_key, p_description, p_severity, p_entry_id, p_related_entry_ids,
    p_vendor_id, p_amount_at_risk, p_evidence, p_detected_by_run, now()
  )
  on conflict (dedup_key) do update set
    description       = excluded.description,
    severity          = excluded.severity,
    amount_at_risk    = excluded.amount_at_risk,
    evidence          = excluded.evidence,
    related_entry_ids = excluded.related_entry_ids,
    detected_by_run   = excluded.detected_by_run,
    last_detected_at  = now()
    -- status, resolved_by and resolved_at stay absent from the SET list: a
    -- confirmed or dismissed flag keeps its human verdict and is never reopened
    -- by a later run.
  returning id into v_id;

  return v_id;
end;
$$;

-- Belt and braces. Even as SECURITY INVOKER the function has no business being
-- in the public API surface, and `anon` is named explicitly this time.
revoke all on function public.upsert_flag(
  text, text, text, text, bigint, bigint[], bigint, numeric, jsonb, text)
  from public, anon, authenticated;

grant execute on function public.upsert_flag(
  text, text, text, text, bigint, bigint[], bigint, numeric, jsonb, text)
  to service_role;
