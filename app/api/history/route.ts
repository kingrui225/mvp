import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { PostResult, SearchRecord, TranscriptResult } from '../search/route'

/** GET /api/history — returns all visible past searches for the authed user, newest first */
export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Step 1: Collect hidden event IDs and whether there's a hide-all event.
  const { data: hideRows } = await supabase
    .from('search_hide_events')
    .select('search_event_id, hide_all, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  const hiddenIds = new Set<string>()
  let hideAllSince: string | null = null
  for (const row of hideRows ?? []) {
    if (row.hide_all) {
      if (!hideAllSince || row.created_at < hideAllSince) {
        hideAllSince = row.created_at
      }
    } else if (row.search_event_id) {
      hiddenIds.add(row.search_event_id)
    }
  }

  // Step 2: Fetch search events with results joined.
  const { data: events, error } = await supabase
    .from('search_events')
    .select(`
      id,
      query,
      search_type,
      result_limit,
      result_count,
      created_at,
      search_result_events (
        pk, code, url, media_type, thumbnail_url, video_url,
        caption, like_count, comment_count, view_count,
        taken_at, ig_username, user_pk, is_verified
      )
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[history] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }

  // Step 3: Filter out hidden records client-side.
  const visible = (events ?? []).filter((ev) => {
    if (hiddenIds.has(ev.id)) return false
    if (hideAllSince && (ev.created_at as string) <= hideAllSince) return false
    return true
  })

  if (visible.length === 0) {
    return NextResponse.json([])
  }

  // Step 4: Fetch transcript metadata for the visible search events.
  // We include transcript_text (plain text) but not segments to keep responses lean.
  const visibleIds = visible.map((ev) => ev.id as string)
  const { data: transcriptRows } = await supabase
    .from('reel_transcript_events')
    .select(
      'search_event_id, post_code, transcript_text, language, duration_seconds, word_count, whisper_model, audio_storage_path, transcript_storage_path, status'
    )
    .in('search_event_id', visibleIds)
    .eq('status', 'complete')

  // Build lookup: `${search_event_id}:${post_code}` → transcript partial
  const transcriptMap = new Map<string, Partial<TranscriptResult>>()
  for (const t of transcriptRows ?? []) {
    const key = `${t.search_event_id}:${t.post_code}`
    transcriptMap.set(key, {
      text: (t.transcript_text as string | null) ?? '',
      language: (t.language as string | undefined) ?? undefined,
      duration_seconds: (t.duration_seconds as number | null) ?? undefined,
      word_count: (t.word_count as number | null) ?? undefined,
      model: (t.whisper_model as string | null) ?? undefined,
      audio_storage_path: (t.audio_storage_path as string | null) ?? undefined,
      transcript_storage_path: (t.transcript_storage_path as string | null) ?? undefined,
    })
  }

  return NextResponse.json(toSearchRecords(visible, transcriptMap))
}

function toSearchRecords(
  events: Array<Record<string, unknown>>,
  transcriptMap: Map<string, Partial<TranscriptResult>>,
): SearchRecord[] {
  return events.map((ev) => ({
    id: ev.id as string,
    timestamp: ev.created_at as string,
    query: ev.query as string,
    search_type: ev.search_type as SearchRecord['search_type'],
    limit: ev.result_limit as number,
    results: ((ev.search_result_events ?? []) as Array<Record<string, unknown>>).map((r): PostResult => {
      const code = r.code as string | undefined
      const transcript = code ? transcriptMap.get(`${ev.id}:${code}`) : undefined
      return {
        pk: r.pk as string | undefined,
        code,
        url: r.url as string | undefined,
        media_type: r.media_type as PostResult['media_type'],
        thumbnail_url: r.thumbnail_url as string | undefined,
        video_url: r.video_url as string | undefined,
        caption: r.caption as string | undefined,
        like_count: r.like_count as number | undefined,
        comment_count: r.comment_count as number | undefined,
        view_count: r.view_count as number | undefined,
        taken_at: r.taken_at as string | undefined,
        username: r.ig_username as string | undefined,
        user_pk: r.user_pk as string | undefined,
        is_verified: r.is_verified as boolean | undefined,
        transcript: transcript as TranscriptResult | undefined,
      }
    }),
  }))
}

/**
 * DELETE /api/history?id=<uuid>
 *
 * Append-only: inserts a hide event instead of deleting the source row.
 * Source data is preserved for audit; it just stops appearing in history.
 * If id is omitted, hides ALL history for the user via a hide_all=true event.
 */
export async function DELETE(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')

  if (id) {
    // Validate id is a UUID to prevent injection
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    // Append-only hide: insert into search_hide_events
    // ON CONFLICT DO NOTHING handled by unique index (already hidden = no-op)
    const { error: hideErr } = await supabase.from('search_hide_events').insert({
      user_id: user.id,
      search_event_id: id,
      hide_all: false,
    })

    if (hideErr && hideErr.code !== '23505') {
      console.error('[history] hide insert error:', hideErr.message)
      return NextResponse.json({ error: 'Failed to hide record' }, { status: 500 })
    }
  } else {
    // Hide-all: a single hide_all=true row hides all events up to this timestamp.
    const { error: hideAllErr } = await supabase.from('search_hide_events').insert({
      user_id: user.id,
      search_event_id: null,
      hide_all: true,
    })

    if (hideAllErr) {
      console.error('[history] hide-all insert error:', hideAllErr.message)
      return NextResponse.json({ error: 'Failed to clear history' }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true })
}
