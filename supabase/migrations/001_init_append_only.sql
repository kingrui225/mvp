-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001 — Append-only event schema
--
-- Principles:
--  • Every table is INSERT-only at the RLS level (no UPDATE, no DELETE).
--  • "Current state" is always derived from the latest event, not a mutable row.
--  • Idempotency keys + ON CONFLICT DO NOTHING prevent duplicate inserts.
--  • auth.uid() scopes every RLS policy — users never see each other's data.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Extensions ───────────────────────────────────────────────────────────────
create extension if not exists "pgcrypto";

-- ── Helpers ──────────────────────────────────────────────────────────────────
create or replace function public.now_utc()
returns timestamptz
language sql stable
as $$ select now() at time zone 'utc' $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. PROFILES
--    One row per auth user, created automatically on signup via trigger.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  created_at  timestamptz not null default public.now_utc()
);

alter table public.profiles enable row level security;

create policy "profiles: owner read"
  on public.profiles for select
  using (auth.uid() = id);

-- Trigger: auto-create profile on new auth.user
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. INSTAGRAM_ACCOUNTS
--    Metadata about a linked Instagram account (no session secrets here).
--    Append-only: "disconnected" status is recorded as a new row, not deletion.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.instagram_accounts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  ig_user_id      text,                           -- Instagram ds_user_id
  ig_username     text,
  status          text not null default 'active'  -- 'active' | 'disconnected'
                  check (status in ('active', 'disconnected')),
  created_at      timestamptz not null default public.now_utc()
);

alter table public.instagram_accounts enable row level security;

create policy "ig_accounts: owner read"
  on public.instagram_accounts for select
  using (auth.uid() = user_id);

create policy "ig_accounts: owner insert"
  on public.instagram_accounts for insert
  with check (auth.uid() = user_id);

-- No UPDATE or DELETE policy — history is preserved as append-only rows.

-- View: latest status per user
create or replace view public.v_instagram_account_status as
select distinct on (user_id)
  user_id, ig_user_id, ig_username, status, created_at
from public.instagram_accounts
order by user_id, created_at desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. INSTAGRAM_SESSION_EVENTS
--    Encrypted instagrapi session blobs — only the server can read/write these
--    via the service-role key. RLS blocks anon/user direct access.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.instagram_session_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  ig_account_id   uuid references public.instagram_accounts (id),
  session_blob    text not null,   -- AES-256-GCM encrypted JSON (see lib/encrypt.ts)
  created_at      timestamptz not null default public.now_utc()
);

alter table public.instagram_session_events enable row level security;

-- Users CANNOT directly read their own session blobs (only the server can).
-- Service-role key bypasses RLS entirely.
create policy "ig_sessions: no direct user access"
  on public.instagram_session_events for select
  using (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. SEARCH_EVENTS
--    One row per search request. Results stored in child table.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.search_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  query           text not null,
  search_type     text not null check (search_type in ('top', 'reel', 'hashtag', 'place')),
  result_limit    integer not null default 100,
  result_count    integer not null default 0,
  created_at      timestamptz not null default public.now_utc()
);

alter table public.search_events enable row level security;

create policy "search_events: owner read"
  on public.search_events for select
  using (auth.uid() = user_id);

create policy "search_events: owner insert"
  on public.search_events for insert
  with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. SEARCH_RESULT_EVENTS
--    Individual post results, child of search_events. Insert-only.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.search_result_events (
  id              uuid primary key default gen_random_uuid(),
  search_event_id uuid not null references public.search_events (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  pk              text,
  code            text,
  url             text,
  media_type      text,
  thumbnail_url   text,
  video_url       text,
  caption         text,
  like_count      integer,
  comment_count   integer,
  view_count      integer,
  taken_at        timestamptz,
  ig_username     text,
  user_pk         text,
  is_verified     boolean,
  created_at      timestamptz not null default public.now_utc()
);

alter table public.search_result_events enable row level security;

create policy "search_results: owner read"
  on public.search_result_events for select
  using (auth.uid() = user_id);

create policy "search_results: owner insert"
  on public.search_result_events for insert
  with check (auth.uid() = user_id);

-- Optimised lookups
create index if not exists idx_search_result_events_search_id
  on public.search_result_events (search_event_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. BILLING_EVENTS
--    Stripe lifecycle events (subscription created, updated, cancelled, etc.).
--    Written only by the webhook handler using the service-role key.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.billing_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid references public.profiles (id),
  stripe_customer_id  text,
  stripe_event_id     text unique not null,          -- idempotency key
  stripe_event_type   text not null,
  subscription_id     text,
  subscription_status text,
  price_id            text,
  current_period_end  timestamptz,
  payload             jsonb,                         -- raw Stripe event (no secrets)
  created_at          timestamptz not null default public.now_utc()
);

alter table public.billing_events enable row level security;

create policy "billing_events: owner read"
  on public.billing_events for select
  using (auth.uid() = user_id);

-- Only service-role (webhook) can insert.
create policy "billing_events: no direct user insert"
  on public.billing_events for insert
  with check (false);

-- View: active subscription derived from latest billing events
create or replace view public.v_active_subscription as
select distinct on (user_id)
  user_id,
  stripe_customer_id,
  subscription_id,
  subscription_status,
  price_id,
  current_period_end,
  created_at as last_event_at
from public.billing_events
where stripe_event_type like 'customer.subscription%'
order by user_id, created_at desc;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. PROFILES — add stripe_customer_id column
--    Separate from profiles to avoid updates; but stripe_customer_id is idempotent
--    once set (Stripe never changes it), so a nullable column here is safe.
-- ─────────────────────────────────────────────────────────────────────────────
alter table public.profiles
  add column if not exists stripe_customer_id text unique;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. WEBHOOK_RECEIPTS
--    Idempotency log — before processing any webhook, insert here.
--    ON CONFLICT DO NOTHING = safe replay protection.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.webhook_receipts (
  stripe_event_id text primary key,
  processed_at    timestamptz not null default public.now_utc()
);

alter table public.webhook_receipts enable row level security;

-- Only service-role (webhook handler) interacts with this table.
create policy "webhook_receipts: no user access"
  on public.webhook_receipts for all
  using (false);

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. RATE_LIMIT_EVENTS
--    Lightweight abuse log for Instagram connect/challenge attempts.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.rate_limit_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references public.profiles (id),
  ip_hash     text,               -- SHA-256 of IP; no raw IPs stored
  action      text not null,      -- 'ig_connect' | 'ig_challenge'
  success     boolean not null,
  created_at  timestamptz not null default public.now_utc()
);

alter table public.rate_limit_events enable row level security;

-- Only service-role writes to this table.
create policy "rate_limits: no direct user access"
  on public.rate_limit_events for all
  using (false);
