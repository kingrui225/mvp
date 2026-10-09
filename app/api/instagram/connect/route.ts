import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { checkRateLimit, clientIp, hashIp, recordRateLimit } from '@/lib/rate-limit'
import { encrypt } from '@/lib/encrypt'
import { runInstagramCommand } from '@/lib/instagram'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const GENERIC_AUTH_ERROR = 'Could not connect Instagram. Check your details and try again.'

/** Shared helper: persist a successful session result to Supabase */
async function persistSession(
  userId: string,
  result: { username?: string; user_id?: string; session?: Record<string, unknown> },
  fallbackUsername: string,
) {
  const supabase = await createClient()
  const { data: account, error: accountError } = await supabase
    .from('instagram_accounts')
    .insert({
      user_id: userId,
      ig_user_id: result.user_id ?? null,
      ig_username: result.username ?? fallbackUsername,
      status: 'active',
    })
    .select('id')
    .single()

  if (accountError || !account) return { ok: false as const }

  const admin = createAdminClient()
  const { error: sessionError } = await admin.from('instagram_session_events').insert({
    user_id: userId,
    ig_account_id: account.id,
    session_blob: encrypt(JSON.stringify(result.session)),
  })

  if (sessionError) return { ok: false as const }
  return { ok: true as const, username: result.username ?? fallbackUsername, user_id: result.user_id ?? null }
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireUser()
  if (error) return error

  let body: { method?: string; username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const ipHash = hashIp(clientIp(req.headers))

  // ── Browser login (Selenium popup) ──────────────────────────────────────────
  if (body.method === 'browser') {
    const limited = await checkRateLimit({ userId: user.id, ipHash, action: 'ig_connect' })
    if (!limited.ok) return NextResponse.json({ error: limited.error }, { status: limited.status })

    // 5-minute timeout — user needs time to log in
    const result = await runInstagramCommand({ cmd: 'browser_login', timeout_seconds: 300 }, 330_000)

    if (!result.ok) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: result.error ?? GENERIC_AUTH_ERROR }, { status: 401 })
    }
    if (!result.session) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    const saved = await persistSession(user.id, result, result.username ?? 'instagram')
    if (!saved.ok) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }
    await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: true })
    return NextResponse.json({ ok: true, username: saved.username, user_id: saved.user_id })
  }

  // ── Username / password login ───────────────────────────────────────────────
  const username = (body.username ?? '').trim()
  const password = body.password ?? ''
  if (!username || !password) {
    return NextResponse.json({ error: 'username and password are required' }, { status: 400 })
  }
  if (username.length > 64 || password.length > 128) {
    return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 400 })
  }

  const limited = await checkRateLimit({ userId: user.id, ipHash, action: 'ig_connect' })
  if (!limited.ok) return NextResponse.json({ error: limited.error }, { status: limited.status })

  try {
    console.log('[ig/connect] calling runInstagramCommand login for', username)
    const result = await runInstagramCommand({ cmd: 'login', username, password })
    console.log('[ig/connect] result ok=%s challenge=%s error=%s', result.ok, result.challenge_required, result.error)

    if (!result.ok) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      if (result.challenge_required) {
        return NextResponse.json({
          ok: false,
          challenge_required: true,
          error: 'Instagram requires a verification code.',
        })
      }
      return NextResponse.json({ ok: false, error: result.error ?? GENERIC_AUTH_ERROR }, { status: 401 })
    }

    if (!result.session) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    const saved = await persistSession(user.id, result, username)
    if (!saved.ok) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }
    await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: true })
    return NextResponse.json({ ok: true, username: saved.username, user_id: saved.user_id })
  } finally {
    body.password = ''
  }
}
