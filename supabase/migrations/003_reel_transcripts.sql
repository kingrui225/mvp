-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — Reel transcript artifacts
--
-- Adds:
--  • storage.buckets entry for reel-artifacts (private bucket)
--  • storage.objects RLS policies scoped to owner user_id
--  • reel_transcript_events: append-only transcript metadata rows
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Supabase Storage bucket ──────────────────────────────────────────────────
-- Private bucket — 50 MB max per file, accepts MP3 + JSON.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reel-artifacts',
  'reel-artifacts',
  false,
  52428800,
  array['audio/mpeg', 'application/json']
)
on conflict (id) do nothing;

-- Storage RLS: authenticated users can read only their own files.
-- Path convention: {user_id}/{post_code}/{filename}
-- The first folder segment must match auth.uid().

-- Drop legacy policies if they exist so re-runs are idempotent.
drop policy if exists "reel_artifacts: owner read" on storage.objects;
drop policy if exists "reel_artifacts: service upsert" on storage.objects;
drop policy if exists "reel_artifacts: service update" on storage.objects;

create policy "reel_artifacts: owner read"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'reel-artifacts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Service role (used by the Railway worker) can create + replace files.
create policy "reel_artifacts: service upsert"
  on storage.objects for insert
  to service_role
  with check (bucket_id = 'reel-artifacts');

create policy "reel_artifacts: service update"
  on storage.objects for update
  to service_role
  using (bucket_id = 'reel-artifacts');

-- ── REEL_TRANSCRIPT_EVENTS ────────────────────────────────────────────────────
-- One row per reel transcription attempt, child of search_result_events.
-- Insert-only; status 'failed' rows preserve the error for debugging.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.reel_transcript_events (
  id                      uuid        primary key default gen_random_uuid(),
  search_event_id         uuid        not null references public.search_events (id) on delete cascade,
  user_id                 uuid        not null references public.profiles (id) on delete cascade,
  post_code               text        not null,
  post_url                text,
  -- Supabase Storage object paths (bucket = reel-artifacts)
  audio_storage_path      text,       -- {user_id}/{post_code}/audio.mp3
  transcript_storage_path text,       -- {user_id}/{post_code}/transcript.json
  -- Transcript content
  transcript_text         text,       -- full plain-text transcript
  language                text,       -- ISO 639-1 detected language
  duration_seconds        real,       -- audio duration
  word_count              integer,
  whisper_model           text,       -- e.g. "large-v2", "medium"
  -- Status tracking
  status                  text        not null default 'complete'
                          check (status in ('complete', 'failed')),
  error_message           text,       -- set when status = 'failed'
  created_at              timestamptz not null default public.now_utc()
);

alter table public.reel_transcript_events enable row level security;

create policy "reel_transcripts: owner read"
  on public.reel_transcript_events for select
  using (auth.uid() = user_id);

create policy "reel_transcripts: owner insert"
  on public.reel_transcript_events for insert
  with check (auth.uid() = user_id);

grant select, insert on public.reel_transcript_events to authenticated;

-- Efficient lookups by search event and by user + post_code for dedup.
create index if not exists idx_reel_transcript_events_search
  on public.reel_transcript_events (search_event_id);

create index if not exists idx_reel_transcript_events_user_code
  on public.reel_transcript_events (user_id, post_code, created_at desc);

-- View: latest successful transcript per post_code per user.
create or replace view public.v_latest_reel_transcript as
select distinct on (user_id, post_code)
  id, user_id, post_code, post_url,
  audio_storage_path, transcript_storage_path,
  transcript_text, language, duration_seconds, word_count, whisper_model,
  status, created_at
from public.reel_transcript_events
where status = 'complete'
order by user_id, post_code, created_at desc;
