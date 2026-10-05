import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { SearchRecord } from '../search/route'

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
      // Use the earliest (most aggressive) hide-all timestamp
      if (!hideAllSince || row.created_at < hideAllSince) {
        hideAllSince = row.created_at
      }
    } else if (row.search_event_id) {
      hiddenIds.add(row.search_event_id)
    }
  }

  // Step 2: Fetch search events with results joined.
  const query = supabase
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

  const { data: events, error } = await query

  if (error) {
    console.error('[history] DB error:', error.message)
    return NextResponse.json({ error: 'Failed to load history' }, { status: 500 })
  }

  // Step 3: Filter out hidden records client-side.
  const visible = (events ?? []).filter((ev) => {
    if (hiddenIds.has(ev.id)) return false
    if (hideAllSince && ev.created_at <= hideAllSince) return false
    return true
  })

  return NextResponse.json(toSearchRecords(visible))
}

function toSearchRecords(events: Array<Record<string, unknown>>): SearchRecord[] {
  return events.map((ev) => ({
    id: ev.id as string,
    timestamp: ev.created_at as string,
    query: ev.query as string,
    search_type: ev.search_type as SearchRecord['search_type'],
    limit: ev.result_limit as number,
    results: ((ev.search_result_events ?? []) as Array<Record<string, unknown>>).map((r) => ({
      pk: r.pk as string | undefined,
      code: r.code as string | undefined,
      url: r.url as string | undefined,
      media_type: r.media_type as string | undefined,
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
    })),
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
