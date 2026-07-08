create table if not exists public.llm_router_outcomes (
  id text primary key,
  request_id text not null,
  trajectory_id text,
  agent_id text,
  model_id text not null,
  task_type text not null,
  success boolean not null,
  validation_passed boolean,
  needed_escalation boolean not null default false,
  quality_score numeric(4, 3),
  actual_cost_usd numeric(12, 6),
  actual_latency_ms integer,
  error_type text,
  evaluator_type text not null default 'rule',
  evaluator_model_id text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.llm_router_model_task_scores (
  model_id text not null,
  task_type text not null,
  sample_count integer not null default 0,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  success_rate numeric(5, 4) not null default 0,
  avg_quality_score numeric(5, 4) not null default 0,
  avg_cost_usd numeric(12, 6) not null default 0,
  avg_latency_ms numeric(12, 2) not null default 0,
  escalation_rate numeric(5, 4) not null default 0,
  learned_score numeric(5, 4) not null default 0,
  last_outcome_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (model_id, task_type)
);

create table if not exists public.llm_router_shadow_evals (
  id text primary key,
  request_id text not null,
  selected_model_id text not null,
  shadow_model_id text not null,
  task_type text not null,
  selected_estimated_cost_usd numeric(12, 6) not null default 0,
  shadow_estimated_cost_usd numeric(12, 6) not null default 0,
  strategy text not null,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.llm_router_outcomes enable row level security;
alter table public.llm_router_model_task_scores enable row level security;
alter table public.llm_router_shadow_evals enable row level security;

create index if not exists llm_router_outcomes_request_id_idx
  on public.llm_router_outcomes (request_id);

create index if not exists llm_router_outcomes_model_task_created_idx
  on public.llm_router_outcomes (model_id, task_type, created_at desc);

create index if not exists llm_router_outcomes_trajectory_id_idx
  on public.llm_router_outcomes (trajectory_id)
  where trajectory_id is not null;

create index if not exists llm_router_model_task_scores_learned_idx
  on public.llm_router_model_task_scores (task_type, learned_score desc, sample_count desc);

create index if not exists llm_router_shadow_evals_request_id_idx
  on public.llm_router_shadow_evals (request_id);

-- These eval/learning tables are backend-only until tenant auth and scoped policies exist.
-- Trusted services should write with a Supabase secret/service key.
