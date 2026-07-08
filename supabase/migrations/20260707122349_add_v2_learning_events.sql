create table if not exists public.docrouter_v2_events (
  id text primary key,
  session_id text not null,
  user_id text,
  event_type text not null,
  request_id text,
  model_id text,
  task_type text,
  document_profile jsonb,
  extraction_instruction text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.docrouter_v2_events enable row level security;

create table if not exists public.docrouter_v2_provider_credentials (
  session_id text not null,
  user_id text,
  provider text not null,
  encrypted_api_key text not null,
  base_url text,
  updated_at timestamptz not null default now(),
  primary key (session_id, provider)
);

alter table public.docrouter_v2_provider_credentials enable row level security;

create table if not exists public.docrouter_v2_runs (
  id text primary key,
  session_id text not null,
  user_id text,
  request_id text not null,
  model_id text not null,
  task_type text not null,
  file_name text,
  file_mime_type text,
  file_size bigint,
  ocr_engine text,
  ocr_warnings jsonb not null default '[]'::jsonb,
  document_profile jsonb,
  extraction_instruction text,
  extraction jsonb,
  evaluation jsonb,
  dry_run boolean not null default true,
  estimated_cost_usd numeric,
  actual_cost_usd numeric,
  latency_ms integer,
  created_at timestamptz not null default now()
);

alter table public.docrouter_v2_runs enable row level security;

create index if not exists docrouter_v2_events_session_created_idx
  on public.docrouter_v2_events (session_id, created_at desc);

create index if not exists docrouter_v2_events_user_created_idx
  on public.docrouter_v2_events (user_id, created_at desc)
  where user_id is not null;

create index if not exists docrouter_v2_events_model_task_idx
  on public.docrouter_v2_events (model_id, task_type, event_type)
  where model_id is not null;

create index if not exists docrouter_v2_events_event_type_idx
  on public.docrouter_v2_events (event_type, created_at desc);

create index if not exists docrouter_v2_events_payload_gin_idx
  on public.docrouter_v2_events using gin (payload);

create index if not exists docrouter_v2_credentials_user_idx
  on public.docrouter_v2_provider_credentials (user_id, updated_at desc)
  where user_id is not null;

create index if not exists docrouter_v2_runs_session_created_idx
  on public.docrouter_v2_runs (session_id, created_at desc);

create index if not exists docrouter_v2_runs_user_created_idx
  on public.docrouter_v2_runs (user_id, created_at desc)
  where user_id is not null;

create index if not exists docrouter_v2_runs_model_task_idx
  on public.docrouter_v2_runs (model_id, task_type, created_at desc);

drop policy if exists "Service role can manage V2 learning events" on public.docrouter_v2_events;
create policy "Service role can manage V2 learning events"
  on public.docrouter_v2_events
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Service role can manage V2 credentials" on public.docrouter_v2_provider_credentials;
create policy "Service role can manage V2 credentials"
  on public.docrouter_v2_provider_credentials
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists "Service role can manage V2 runs" on public.docrouter_v2_runs;
create policy "Service role can manage V2 runs"
  on public.docrouter_v2_runs
  for all
  to service_role
  using (true)
  with check (true);

create or replace view public.docrouter_v2_model_feedback_summary
with (security_invoker = true) as
select
  model_id,
  task_type,
  count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')) as feedback_count,
  count(*) filter (where event_type = 'feedback_happy') as happy_count,
  count(*) filter (where event_type = 'feedback_not_happy') as not_happy_count,
  case
    when count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')) = 0 then null
    else round(
      (count(*) filter (where event_type = 'feedback_happy'))::numeric
      / (count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')))::numeric,
      4
    )
  end as happy_rate,
  avg((payload->'evaluation'->>'qualityScore')::numeric) filter (where payload ? 'evaluation') as avg_eval_quality,
  max(created_at) as last_seen_at
from public.docrouter_v2_events
where model_id is not null
group by model_id, task_type;

create or replace view public.docrouter_v2_user_model_feedback_summary
with (security_invoker = true) as
select
  user_id,
  model_id,
  task_type,
  count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')) as feedback_count,
  count(*) filter (where event_type = 'feedback_happy') as happy_count,
  count(*) filter (where event_type = 'feedback_not_happy') as not_happy_count,
  case
    when count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')) = 0 then null
    else round(
      (count(*) filter (where event_type = 'feedback_happy'))::numeric
      / (count(*) filter (where event_type in ('feedback_happy', 'feedback_not_happy')))::numeric,
      4
    )
  end as user_happy_rate,
  avg((payload->'evaluation'->>'qualityScore')::numeric) filter (where payload ? 'evaluation') as avg_eval_quality,
  max(created_at) as last_seen_at
from public.docrouter_v2_events
where user_id is not null
  and model_id is not null
group by user_id, model_id, task_type;
