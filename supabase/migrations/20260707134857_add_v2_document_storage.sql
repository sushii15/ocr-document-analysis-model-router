insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'docrouter-v2-documents',
  'docrouter-v2-documents',
  false,
  52428800,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.docrouter_v2_runs
  add column if not exists storage_bucket text,
  add column if not exists storage_path text;

create index if not exists docrouter_v2_runs_storage_path_idx
  on public.docrouter_v2_runs (storage_bucket, storage_path)
  where storage_path is not null;

drop policy if exists "Users can read own DocRouter documents" on storage.objects;
create policy "Users can read own DocRouter documents"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'docrouter-v2-documents'
    and (select auth.uid())::text = split_part(name, '/', 1)
  );

drop policy if exists "Users can upload own DocRouter documents" on storage.objects;
create policy "Users can upload own DocRouter documents"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'docrouter-v2-documents'
    and (select auth.uid())::text = split_part(name, '/', 1)
  );

drop policy if exists "Users can delete own DocRouter documents" on storage.objects;
create policy "Users can delete own DocRouter documents"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'docrouter-v2-documents'
    and (select auth.uid())::text = split_part(name, '/', 1)
  );
