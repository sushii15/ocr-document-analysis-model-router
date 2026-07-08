create table if not exists public.llm_router_decisions (
  id text primary key,
  trajectory_id text,
  agent_id text,
  step_type text,
  detected_task_type text not null,
  selected_model_id text not null,
  selected_model_provider text not null,
  selected_model_tier text not null,
  fallback_model_id text,
  estimated_cost_usd numeric(12, 6) not null default 0,
  estimated_latency_ms integer not null default 0,
  classification_confidence numeric(4, 3) not null default 0,
  policy_applied jsonb not null default '{}'::jsonb,
  model_scores jsonb not null default '[]'::jsonb,
  alternatives_considered jsonb not null default '[]'::jsonb,
  reasoning text not null,
  raw_decision jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.llm_router_trajectories (
  id text primary key,
  agent_id text,
  start_model_id text not null,
  current_model_id text not null,
  step_count integer not null default 0,
  total_cost_usd numeric(12, 6) not null default 0,
  budget_remaining_usd numeric(12, 6),
  step_history jsonb not null default '[]'::jsonb,
  started_at timestamptz not null,
  last_updated_at timestamptz not null
);

alter table public.llm_router_decisions enable row level security;
alter table public.llm_router_trajectories enable row level security;

create index if not exists llm_router_decisions_created_at_idx
  on public.llm_router_decisions (created_at desc);

create index if not exists llm_router_decisions_trajectory_id_idx
  on public.llm_router_decisions (trajectory_id)
  where trajectory_id is not null;

create index if not exists llm_router_decisions_agent_id_idx
  on public.llm_router_decisions (agent_id)
  where agent_id is not null;

create index if not exists llm_router_decisions_model_tier_idx
  on public.llm_router_decisions (selected_model_tier, created_at desc);

create index if not exists llm_router_decisions_task_type_idx
  on public.llm_router_decisions (detected_task_type, created_at desc);

create index if not exists llm_router_trajectories_agent_id_idx
  on public.llm_router_trajectories (agent_id)
  where agent_id is not null;

-- The router writes from a trusted backend using a Supabase secret/service key.
-- Keep anon/authenticated access closed until tenant ownership is finalized.
