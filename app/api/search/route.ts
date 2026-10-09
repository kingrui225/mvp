import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/encrypt'
import { runInstagramCommand } from '@/lib/instagram'
import { hasActiveSubscription } from '@/lib/entitlement'

export type SearchType = 'top' | 'reel' | 'hashtag' | 'place'

export interface PostResult {
  pk?: string
  code?: string
  url?: string
  media_type?: 'photo' | 'video' | 'carousel' | 'place'
  thumbnail_url?: string
  video_url?: string
  caption?: string
  like_count?: number
  comment_count?: number
  view_count?: number
  taken_at?: string
  username?: string
  user_pk?: string
  is_verified?: boolean
}

export interface SearchRecord {
  id: string
  timestamp: string
  query: string
  search_type: SearchType
  limit: number
  results: PostResult[]
}

const DEFAULT_LIMIT = 100

export async function POST(req: NextRequest) {
  // ── Auth guard ────────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Subscription guard ────────────────────────────────────────────────────
  // Set BILLING_GATE_ENABLED=true in env to enforce subscriptions.
  const gateEnabled = process.env.BILLING_GATE_ENABLED === 'true'
  if (gateEnabled) {
    const hasSub = await hasActiveSubscription(user.id)
    if (!hasSub) {
      return NextResponse.json({ error: 'subscription_required' }, { status: 402 })
    }
  }

  // ── Input validation ──────────────────────────────────────────────────────
  let body: { query?: string; search_type?: string; limit?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const query = (body.query ?? '').trim()
  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }
  if (query.length > 500) {
    return NextResponse.json({ error: 'query too long' }, { status: 400 })
  }

  const validTypes: SearchType[] = ['top', 'reel', 'hashtag', 'place']
  const searchType: SearchType = validTypes.includes(body.search_type as SearchType)
    ? (body.search_type as SearchType)
    : 'top'

  const limit = Math.max(1, Math.min(500, Number(body.limit) || DEFAULT_LIMIT))

  // ── Fetch + decrypt session for this user ─────────────────────────────────
  // Admin client bypasses RLS on instagram_session_events (no user select policy).
  const admin = createAdminClient()
  const { data: sessionRow } = await admin
    .from('instagram_session_events')
    .select('session_blob')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let sessionData: Record<string, unknown> | null = null
  if (sessionRow?.session_blob) {
    try {
      sessionData = JSON.parse(decrypt(sessionRow.session_blob)) as Record<string, unknown>
    } catch {
      // Decryption failure — session is corrupt; continue without session
      // (search will fail at the Python layer with a clear error).
    }
  }

  // ── Run search via JSON-RPC ───────────────────────────────────────────────
  try {
    const result = await runInstagramCommand(
      {
        cmd: 'search',
        query,
        search_type: searchType,
        limit,
        session: sessionData ?? undefined,
      },
      120_000,
    )

    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'Search failed.' }, { status: 500 })
    }

    const rawResults = (result.results ?? []) as PostResult[]
    const searchEventId = randomUUID()
    const now = new Date().toISOString()

    // ── Persist to Supabase (append-only) ────────────────────────────────────
    const { error: evErr } = await supabase
      .from('search_events')
      .insert({
        id: searchEventId,
        user_id: user.id,
        query: result.query ?? query,
        search_type: (result.search_type ?? searchType) as string,
        result_limit: result.limit ?? limit,
        result_count: rawResults.length,
        created_at: now,
      })

    if (evErr) {
      console.error('[search] Failed to insert search_event:', evErr.message)
    }

    if (rawResults.length > 0) {
      const rows = rawResults.map((r) => ({
        search_event_id: searchEventId,
        user_id: user.id,
        pk: r.pk ?? null,
        code: r.code ?? null,
        url: r.url ?? null,
        media_type: r.media_type ?? null,
        thumbnail_url: r.thumbnail_url ?? null,
        video_url: r.video_url ?? null,
        caption: r.caption ?? null,
        like_count: r.like_count ?? null,
        comment_count: r.comment_count ?? null,
        view_count: r.view_count ?? null,
        taken_at: r.taken_at ?? null,
        ig_username: r.username ?? null,
        user_pk: r.user_pk ?? null,
        is_verified: r.is_verified ?? null,
        created_at: now,
      }))

      const { error: resErr } = await supabase.from('search_result_events').insert(rows)
      if (resErr) {
        console.error('[search] Failed to insert search_result_events:', resErr.message)
      }
    }

    const record: SearchRecord = {
      id: searchEventId,
      timestamp: now,
      query: (result.query ?? query) as string,
      search_type: (result.search_type ?? searchType) as SearchType,
      limit: (result.limit ?? limit) as number,
      results: rawResults,
    }
    return NextResponse.json(record)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
