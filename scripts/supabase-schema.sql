-- Sai Health Hub — Supabase schema (Phase 1: durable persistence)
--
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- It is safe to run again (every statement is idempotent).
--
-- Security model:
--   * Row Level Security is ENABLED with NO policies, so the public "anon" key
--     cannot read or write these tables at all.
--   * Only the service-role key can reach them, and that key is read from the
--     server environment (SUPABASE_SERVICE_ROLE_KEY) and never sent to a browser.

create table if not exists public.checkins (
  id text primary key,
  client_id text not null,
  height_cm double precision not null,
  weight_kg double precision not null,
  bmi double precision not null,
  category_id text not null,
  category_label text not null,
  note text not null default '',
  lang text not null default 'en',
  created_at timestamptz not null default now()
);

create index if not exists checkins_client_idx
  on public.checkins (client_id, created_at desc);

-- Generic per-browser key/value store used by the v8 panels
-- (customers, follow-ups, campaign progress, reports, checklists, ...).
create table if not exists public.app_state (
  client_id text not null,
  key text not null,
  value text not null,
  updated_at timestamptz not null default now(),
  primary key (client_id, key)
);

alter table public.checkins enable row level security;
alter table public.app_state enable row level security;

-- No policies are created on purpose: service role bypasses RLS, anon/authenticated do not.
