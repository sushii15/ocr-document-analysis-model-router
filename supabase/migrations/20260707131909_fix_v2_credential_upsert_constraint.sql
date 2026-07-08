do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'docrouter_v2_provider_credentials_credential_id_key'
  ) then
    alter table public.docrouter_v2_provider_credentials
      add constraint docrouter_v2_provider_credentials_credential_id_key unique (credential_id);
  end if;
end $$;
