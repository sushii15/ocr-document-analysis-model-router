create table if not exists public.docrouter_v2_document_intelligence (
  id text primary key,
  session_id text not null,
  user_id text,
  run_id text,
  request_id text,
  file_sha256 text not null,
  file_name text,
  file_mime_type text,
  file_size bigint,
  storage_bucket text,
  storage_path text,
  document_type text,
  task_type text,
  source_institution text,
  layout_fingerprint text,
  visual_fingerprint text,
  ocr_engine text,
  ocr_character_count integer,
  ocr_word_count integer,
  ocr_line_count integer,
  ocr_digit_ratio numeric,
  ocr_currency_count integer,
  ocr_date_count integer,
  ocr_table_signal numeric,
  document_profile jsonb,
  document_features jsonb not null default '{}'::jsonb,
  selected_model_id text,
  evaluation jsonb,
  user_feedback text,
  created_at timestamptz not null default now()
);

alter table public.docrouter_v2_document_intelligence enable row level security;

create index if not exists docrouter_v2_docintel_hash_idx
  on public.docrouter_v2_document_intelligence (file_sha256);

create index if not exists docrouter_v2_docintel_user_created_idx
  on public.docrouter_v2_document_intelligence (user_id, created_at desc)
  where user_id is not null;

create index if not exists docrouter_v2_docintel_pattern_idx
  on public.docrouter_v2_document_intelligence (document_type, source_institution, layout_fingerprint);

create index if not exists docrouter_v2_docintel_model_task_idx
  on public.docrouter_v2_document_intelligence (selected_model_id, task_type, created_at desc)
  where selected_model_id is not null;

create index if not exists docrouter_v2_docintel_features_gin_idx
  on public.docrouter_v2_document_intelligence using gin (document_features);

drop policy if exists "Service role can manage V2 document intelligence" on public.docrouter_v2_document_intelligence;
create policy "Service role can manage V2 document intelligence"
  on public.docrouter_v2_document_intelligence
  for all
  to service_role
  using (true)
  with check (true);

create or replace view public.docrouter_v2_document_pattern_summary
with (security_invoker = true) as
select
  document_type,
  source_institution,
  layout_fingerprint,
  task_type,
  selected_model_id,
  count(*) as sample_count,
  avg((evaluation->>'qualityScore')::numeric) filter (where evaluation ? 'qualityScore') as avg_eval_quality,
  count(*) filter (where user_feedback = 'happy') as happy_count,
  count(*) filter (where user_feedback = 'not_happy') as not_happy_count,
  max(created_at) as last_seen_at
from public.docrouter_v2_document_intelligence
group by document_type, source_institution, layout_fingerprint, task_type, selected_model_id;
