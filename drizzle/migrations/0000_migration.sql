
create extension if not exists pgcrypto;

create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at = now(); return new; end $$;

create table public.reference_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  platform text not null check (platform in ('youtube','tiktok','other')),
  kind text not null check (kind in ('channel','video','profile','video_list')),
  urls text[] not null,
  title text,
  notes text,
  collected jsonb,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  reference_id uuid references public.reference_sources(id) on delete cascade,
  kind text not null check (kind in ('channel','short')),
  status text not null default 'pending',
  report jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.style_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  analysis_id uuid references public.analyses(id) on delete set null,
  profile jsonb not null default '{}'::jsonb,
  edit_template jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.productions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  title text not null default 'Nova produção',
  topic text,
  reference_id uuid references public.reference_sources(id) on delete set null,
  style_id uuid references public.style_profiles(id) on delete set null,
  mode text not null default 'assisted' check (mode in ('auto','assisted')),
  aspect text not null default '9:16' check (aspect in ('9:16','16:9','1:1')),
  status text not null default 'draft',
  current_step text,
  settings jsonb not null default '{}'::jsonb,
  ideas jsonb,
  script jsonb,
  validation jsonb,
  report jsonb,
  output_path text,
  preview_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  production_id uuid not null references public.productions(id) on delete cascade,
  idx int not null,
  narration text not null default '',
  caption text,
  visual_description text,
  visual_query text,
  pause_after_ms int not null default 0,
  sfx text,
  pacing text,
  motion text default 'zoom_in',
  transition text default 'cut',
  duration_s numeric,
  audio_path text,
  audio_duration_s numeric,
  word_timings jsonb,
  asset_id uuid,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  production_id uuid references public.productions(id) on delete set null,
  kind text not null check (kind in ('image','video','audio','music','sfx')),
  source text not null check (source in ('upload','ai_image','ai_video','pexels','pixabay','local')),
  source_url text,
  license text,
  attribution text,
  storage_path text,
  local_path text,
  description text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  type text not null check (type in ('production','analyze_reference')),
  production_id uuid references public.productions(id) on delete cascade,
  reference_id uuid references public.reference_sources(id) on delete cascade,
  analysis_id uuid references public.analyses(id) on delete cascade,
  status text not null default 'queued',
  step text,
  completed_steps text[] not null default '{}',
  progress int not null default 0,
  wait_reason text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  payload jsonb not null default '{}'::jsonb,
  error text,
  locked_by uuid,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  job_id uuid references public.jobs(id) on delete cascade,
  production_id uuid references public.productions(id) on delete cascade,
  level text not null default 'info',
  step text,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create table public.usage_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  job_id uuid references public.jobs(id) on delete set null,
  production_id uuid references public.productions(id) on delete set null,
  provider text not null,
  operation text not null,
  units numeric not null default 0,
  unit_name text not null default 'request',
  cost_usd numeric,
  created_at timestamptz not null default now()
);

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  last_seen_at timestamptz,
  info jsonb,
  revoked boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.user_settings (
  user_id uuid primary key default auth.uid(),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['reference_sources','analyses','style_profiles','productions','scenes','assets','jobs','activity_logs','usage_records','agents','user_settings'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "own rows select" on public.%I for select to authenticated using (auth.uid() = user_id)', t);
    execute format('create policy "own rows insert" on public.%I for insert to authenticated with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows update" on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t);
    execute format('create policy "own rows delete" on public.%I for delete to authenticated using (auth.uid() = user_id)', t);
  end loop;
  foreach t in array array['reference_sources','analyses','style_profiles','productions','scenes','jobs','user_settings'] loop
    execute format('create trigger touch_%I before update on public.%I for each row execute function public.touch_updated_at()', t, t);
  end loop;
end $$;

create index on public.jobs (status, created_at);
create index on public.scenes (production_id, idx);
create index on public.activity_logs (user_id, created_at desc);

alter publication supabase_realtime add table public.jobs;
alter publication supabase_realtime add table public.activity_logs;

create policy "media own read" on storage.objects for select to authenticated using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media own write" on storage.objects for insert to authenticated with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "media own delete" on storage.objects for delete to authenticated using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
