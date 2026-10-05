import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { checkRateLimit, clientIp, hashIp, recordRateLimit } from '@/lib/rate-limit'
import { encrypt } from '@/lib/encrypt'
import { runInstagramCommand } from '@/lib/instagram'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const GENERIC_AUTH_ERROR = 'Could not connect Instagram. Check your details and try again.'

export async function POST(req: NextRequest) {
  const { user, error } = await requireUser()
  if (error) return error

  let body: { username?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const username = (body.username ?? '').trim()
  const password = body.password ?? ''
  if (!username || !password) {
    return NextResponse.json({ error: 'username and password are required' }, { status: 400 })
  }
  if (username.length > 64 || password.length > 128) {
    return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 400 })
  }

  const ipHash = hashIp(clientIp(req.headers))
  const limited = await checkRateLimit({ userId: user.id, ipHash, action: 'ig_connect' })
  if (!limited.ok) {
    return NextResponse.json({ error: limited.error }, { status: limited.status })
  }

  try {
    const result = await runInstagramCommand({ cmd: 'login', username, password })

    if (!result.ok) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      if (result.challenge_required) {
        return NextResponse.json({
          ok: false,
          challenge_required: true,
          error: 'Instagram requires a verification code.',
        })
      }
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 401 })
    }

    if (!result.session) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
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
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    const admin = createAdminClient()
    const { error: sessionError } = await admin.from('instagram_session_events').insert({
      user_id: user.id,
      ig_account_id: account.id,
      session_blob: encrypt(JSON.stringify(result.session)),
    })

    if (sessionError) {
      await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: false })
      return NextResponse.json({ ok: false, error: GENERIC_AUTH_ERROR }, { status: 500 })
    }

    await recordRateLimit({ userId: user.id, ipHash, action: 'ig_connect', success: true })
    return NextResponse.json({
      ok: true,
      username: result.username ?? username,
      user_id: result.user_id ?? null,
    })
  } finally {
    body.password = ''
  }
}
