-- 20260808000026_rls_policies.sql gave reconciliation_exception a select policy
-- (staff-wide) and an update policy (reviewer/admin, for resolve/dismiss --
-- lib/actions/exceptions.ts) but no insert policy at all -- every exception row
-- until now was raised by the service-role OCR pipeline (lib/jobs/handlers/extract.ts).
--
-- The review screen's `E` key (§7: "Flag as exception, with a note") is the first
-- place a signed-in reviewer needs to INSERT one directly, through the session-bound
-- client rather than a service-role path -- there's no multi-table write or
-- cross-department concern here that would justify a SECURITY DEFINER RPC the way
-- verify_document_extraction needed one, just a single-table insert that RLS can gate
-- on its own. Same role gate as the existing update policy: "Resolve or dismiss
-- exceptions" being reviewer/admin (§4.4c) applies just as much to raising a new one.
create policy reconciliation_exception_insert on public.reconciliation_exception for insert to authenticated
  with check ((select private.is_reviewer_or_admin()));
