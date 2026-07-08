create table if not exists public.docrouter_v2_user_profiles (
  user_id text primary key,
  display_name text,
  onboarding_completed boolean not null default false,
  default_strategy text not null default 'balanced',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.docrouter_v2_user_profiles enable row level security;

create table if not exists public.docrouter_v2_user_model_preferences (
  user_id text not null,
  model_id text not null,
  provider text not null,
  enabled boolean not null default true,
  priority integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, model_id)
);

alter table public.docrouter_v2_user_model_preferences enable row level security;

alter table public.docrouter_v2_provider_credentials
  add column if not exists credential_id text,
  add column if not exists key_fingerprint text,
  add column if not exists created_at timestamptz not null default now();

create unique index if not exists docrouter_v2_provider_credentials_user_provider_uidx
  on public.docrouter_v2_provider_credentials (user_id, provider)
  where user_id is not null;

create unique index if not exists docrouter_v2_provider_credentials_credential_id_uidx
  on public.docrouter_v2_provider_credentials (credential_id)
  where credential_id is not null;

create index if not exists docrouter_v2_user_model_preferences_provider_idx
  on public.docrouter_v2_user_model_preferences (provider, enabled);

drop policy if exists "Service role can manage V2 user profiles" on public.docrouter_v2_user_profiles;
create policy "Service role can manage V2 user profiles"
  on public.docrouter_v2_user_profiles
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Service role can manage V2 model preferences" on public.docrouter_v2_user_model_preferences;
create policy "Service role can manage V2 model preferences"
  on public.docrouter_v2_user_model_preferences
  for all
  to service_role
  using (true)
  with check (true);

create or replace view public.docrouter_v2_user_onboarding_summary
with (security_invoker = true) as
select
  p.user_id,
  p.display_name,
  p.onboarding_completed,
  p.default_strategy,
  count(distinct pref.model_id) filter (where pref.enabled) as enabled_model_count,
  count(distinct cred.provider) as configured_provider_count,
  max(greatest(coalesce(pref.updated_at, p.updated_at), coalesce(cred.updated_at, p.updated_at))) as last_configured_at
from public.docrouter_v2_user_profiles p
left join public.docrouter_v2_user_model_preferences pref
  on pref.user_id = p.user_id
left join public.docrouter_v2_provider_credentials cred
  on cred.user_id = p.user_id
group by p.user_id, p.display_name, p.onboarding_completed, p.default_strategy;
