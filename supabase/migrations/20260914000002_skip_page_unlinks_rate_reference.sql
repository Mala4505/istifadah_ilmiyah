-- setPageSkipOverride (lib/actions/review.ts, 20260822000009's doc comment)
-- deliberately failed with a friendly "ask an admin" error when a
-- single-page bill being skipped had already had a rate_reference row
-- written against one of its line items (line_item_id is `on delete no
-- action` by design -- rate_reference is a persistent benchmark table, not
-- meant to silently lose history on an unrelated bill deletion).
--
-- Product decision (2026-09-14): a reviewer who catches bad OCR and skips
-- the page should not have to file an admin ticket for this -- the fix is
-- to detach the history, not keep the bill alive. This RPC nulls
-- rate_reference.line_item_id for every row pointing at the bill's line
-- items (net_rate/vendor/item_key/observed_date etc. all stay -- only the
-- now-dangling FK to the deleted line item is cleared), so the caller's
-- subsequent `delete from document_extraction` no longer hits the FK
-- violation. Same security posture as set_bill_entry_links
-- (20260908000001): security definer because rate_reference has no write
-- policy for `authenticated` at all (20260808000026), gated on
-- is_reviewer_or_admin + can_see_source_document so this can't be used to
-- edit history outside what the reviewer could already do via the skip
-- action itself.
create or replace function public.clear_bill_rate_reference_links(
  p_document_extraction_id bigint
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_sd bigint;
begin
  select de.source_document_id into v_sd
  from public.document_extraction de
  where de.id = p_document_extraction_id;

  if v_sd is null then
    raise exception 'Bill % not found.', p_document_extraction_id;
  end if;

  if not (select private.is_reviewer_or_admin()) then
    raise exception 'Clearing rate history requires the reviewer or admin role.';
  end if;

  if not (select private.can_see_source_document(v_sd)) then
    raise exception 'You do not have access to document %.', v_sd;
  end if;

  update public.rate_reference rr
  set line_item_id = null
  where rr.line_item_id in (
    select li.id
    from public.document_extraction_line_item li
    where li.document_extraction_id = p_document_extraction_id
  );
end;
$$;

revoke all on function public.clear_bill_rate_reference_links(bigint) from public, anon, authenticated;
grant execute on function public.clear_bill_rate_reference_links(bigint) to authenticated;
