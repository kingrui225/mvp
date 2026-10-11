import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { checkRateLimit, clientIp, hashIp, recordRateLimit } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/encrypt'
import { runInstagramCommand, IgFailure } from '@/lib/instagram'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const GENERIC_AUTH_ERROR = 'Could not verify Instagram. Check the code and try again.'

async function getPendingChallengeSettings(userId: string, username: string): Promise<Record<string, unknown> | undefined> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('instagram_login_challenge_events')
    .select('status, pending_settings_blob')
    .eq('user_id', userId)
    .eq('ig_username', username)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data || data.status !== 'pending' || !data.pending_settings_blob) return undefined
  try {
    return JSON.parse(decrypt(data.pending_settings_blob)) as Record<string, unknown>
  } catch {
    console.error('[ig/challenge] pending settings decrypt failed for user=%s username=%s', userId, username)
    return undefined
  }
}

async function markChallengeState(
  userId: string,
  username: string,
  status: 'resolved' | 'failed',
  error?: string,
) {
  const admin = createAdminClient()
  const { error: dbError } = await admin.from('instagram_login_challenge_events').insert({
    user_id: userId,
    ig_username: username,
    status,
    error: error ?? null,
  })
  if (dbError) {
    console.error('[ig/challenge] failed to mark challenge state user=%s username=%s err=%s', userId, username, dbError.message)
  }
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireUser()
  if (error) return error

  let body: { username?: string; password?: string; code?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const username = (body.username ?? '').trim()
  const password = body.password ?? ''
  const code = (body.code ?? '').trim()
  if (!username || !password || !code) {
    return NextResponse.json({ error: 'username, password, and code are required' }, { status: 400 })
  }

  const ipHash = hashIp(clientIp(req.headers))
  const limited = await checkRateLimit({ userId: user.id, ipHash, action: 'ig_challenge' })
  if (!limited.ok) {
    return NextResponse.json({ error: limited.error }, { status: limited.status })
  }

  try {
    const pendingSettings = await getPendingChallengeSettings(user.id, username)
    const result = await runInstagramCommand({ cmd: 'challenge', username, password, code, pending_settings: pendingSettings })
    if (!result.ok || !result.session) {
      const failure = result as IgFailure
      console.error('[ig/challenge] failed code=%s internal=%s', failure.code, failure._internalError ?? failure.error)
      await markChallengeState(user.id, username, 'failed', failure.error)
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_challenge', success: false })
      return NextResponse.json({ ok: false, error: result.ok ? GENERIC_AUTH_ERROR : failure.error }, { status: 401 })
    }

    const supabase = await createClient()
    const { data: account, error: accountError } = await supabase
      .from('instagram_accounts')
      .insert({
        user_id: user.id,
        ig_user_id: result.user_id ?? null,
        ig_username: result.username ?? username,
        status: 'active',
      })
      .select('id')
      .single()

    if (accountError || !account) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_challenge', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    const admin = createAdminClient()
    const { error: sessionError } = await admin.from('instagram_session_events').insert({
      user_id: user.id,
      ig_account_id: account.id,
      session_blob: encrypt(JSON.stringify(result.session)),
    })

    if (sessionError) {
      await markChallengeState(user.id, username, 'failed', 'session_persist_failed')
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_challenge', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    await markChallengeState(user.id, username, 'resolved')
    await recordRateLimit({ userId: user.id, ipHash, action: 'ig_challenge', success: true })
    return NextResponse.json({
      ok: true,
      username: result.username ?? username,
      user_id: result.user_id ?? null,
    })
  } finally {
    body.password = ''
    body.code = ''
  }
}
