-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — Append-only hardening
--
-- Adds:
--  • search_hide_events so history can be hidden without DELETE/UPDATE
--  • unique idempotency keys for Instagram account status snapshots
--  • current-state views used by the app (never overwrite source rows)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Hide / tombstone events for search history ───────────────────────────────
create table if not exists public.search_hide_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  search_event_id uuid references public.search_events (id) on delete cascade,
  hide_all        boolean not null default false,
  created_at      timestamptz not null default public.now_utc()
);

create unique index if not exists idx_search_hide_events_one
  on public.search_hide_events (user_id, search_event_id)
  where search_event_id is not null;

alter table public.search_hide_events enable row level security;

create policy "search_hide_events: owner read"
  on public.search_hide_events for select
  using (auth.uid() = user_id);

create policy "search_hide_events: owner insert"
  on public.search_hide_events for insert
  with check (auth.uid() = user_id);

create index if not exists idx_search_hide_events_user
  on public.search_hide_events (user_id, created_at desc);

-- Visible history: search events minus hide events (and minus hide-all after that event)
create or replace view public.v_search_history as
select e.*
from public.search_events e
where not exists (
  select 1
  from public.search_hide_events h
  where h.user_id = e.user_id
    and (
      h.search_event_id = e.id
      or (h.hide_all = true and h.created_at >= e.created_at)
    )
);

-- ── Instagram current-state views ────────────────────────────────────────────
-- Drop first so we can redefine column order without a rename conflict.
drop view if exists public.v_instagram_account_status;
create view public.v_instagram_account_status as
select distinct on (user_id)
  id,
  user_id,
  ig_user_id,
  ig_username,
  status,
  created_at
from public.instagram_accounts
order by user_id, created_at desc;

-- Latest encrypted session per user (server reads via service role)
create or replace view public.v_latest_instagram_session as
select distinct on (user_id)
  id,
  user_id,
  ig_account_id,
  session_blob,
  created_at
from public.instagram_session_events
order by user_id, created_at desc;

-- ── Billing current-state view ───────────────────────────────────────────────
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
where user_id is not null
  and stripe_event_type like 'customer.subscription%'
order by user_id, created_at desc;

-- ── Rate-limit lookup index ──────────────────────────────────────────────────
create index if not exists idx_rate_limit_events_lookup
  on public.rate_limit_events (user_id, action, created_at desc);

create index if not exists idx_rate_limit_events_ip
  on public.rate_limit_events (ip_hash, action, created_at desc);

-- ── Stripe customer mapping as append-only events ────────────────────────────
create table if not exists public.stripe_customer_events (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles (id) on delete cascade,
  stripe_customer_id  text not null,
  created_at          timestamptz not null default public.now_utc(),
  unique (user_id, stripe_customer_id)
);

alter table public.stripe_customer_events enable row level security;

create policy "stripe_customer_events: owner read"
  on public.stripe_customer_events for select
  using (auth.uid() = user_id);

create or replace view public.v_stripe_customer as
select distinct on (user_id)
  user_id,
  stripe_customer_id,
  created_at
from public.stripe_customer_events
order by user_id, created_at desc;

grant select, insert on public.search_hide_events to authenticated;
grant select on public.stripe_customer_events to authenticated;
grant select, insert on public.instagram_accounts to authenticated;
grant select, insert on public.search_events to authenticated;
grant select, insert on public.search_result_events to authenticated;
grant select on public.billing_events to authenticated;
grant select on public.profiles to authenticated;
