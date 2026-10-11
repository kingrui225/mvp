-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — Durable Instagram challenge state
--
-- Problem:
--   Verification can fail with correct codes when the worker process restarts
--   between the initial login challenge and the code submission.
--
-- Solution:
--   Persist pending instagrapi settings (encrypted by the app layer) so
--   follow-up verification uses the same device/session context.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.instagram_login_challenge_events (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.profiles (id) on delete cascade,
  ig_username           text not null,
  status                text not null check (status in ('pending', 'resolved', 'failed')),
  pending_settings_blob text,
  verification_methods  jsonb,
  error                 text,
  created_at            timestamptz not null default public.now_utc()
);

alter table public.instagram_login_challenge_events enable row level security;

create policy "ig_challenge_events: owner read"
  on public.instagram_login_challenge_events for select
  using (auth.uid() = user_id);

create policy "ig_challenge_events: owner insert"
  on public.instagram_login_challenge_events for insert
  with check (auth.uid() = user_id);

grant select, insert on public.instagram_login_challenge_events to authenticated;

create index if not exists idx_ig_challenge_events_lookup
  on public.instagram_login_challenge_events (user_id, ig_username, created_at desc);

create or replace view public.v_instagram_challenge_status as
select distinct on (user_id, ig_username)
  id,
  user_id,
  ig_username,
  status,
  pending_settings_blob,
  verification_methods,
  error,
  created_at
from public.instagram_login_challenge_events
order by user_id, ig_username, created_at desc;
