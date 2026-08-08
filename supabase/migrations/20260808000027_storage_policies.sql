-- §4.3 Storage -- the gap v1 left open. Table RLS was written; bucket policies were
-- not. Invoices carry vendor bank details.

-- Bucket 'invoice-documents' created private. No public URLs, ever.
insert into storage.buckets (id, name, public)
values ('invoice-documents', 'invoice-documents', false)
on conflict (id) do nothing;

create policy "staff read documents" on storage.objects for select to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_staff()));

create policy "staff upload documents" on storage.objects for insert to authenticated
  with check (bucket_id = 'invoice-documents' and (select private.is_staff()));

-- REQUIRED for re-upload/replace. Storage upsert needs INSERT + SELECT + UPDATE together;
-- with only INSERT, replacing a file fails silently rather than erroring.
create policy "staff replace documents" on storage.objects for update to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_staff()))
  with check (bucket_id = 'invoice-documents' and (select private.is_staff()));

create policy "admins delete documents" on storage.objects for delete to authenticated
  using (bucket_id = 'invoice-documents' and (select private.is_admin()));

-- The app serves documents through short-lived signed URLs (5 minutes) generated
-- server-side. Nothing renders a raw storage path in the browser.
