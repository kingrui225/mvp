/**
 * DELETE /api/instagram/disconnect
 *
 * 1. Fetches the stored session blob and calls rpc_logout so Instagram
 *    invalidates the token server-side — preventing orphaned active sessions
 *    even if the encrypted blob were ever compromised.
 * 2. Inserts a 'disconnected' row in instagram_accounts (append-only).
 *
 * Logout is best-effort: if it fails we still complete the disconnect.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/encrypt'
import { runInstagramCommand } from '@/lib/instagram'

export async function DELETE() {
  const { user, error } = await requireUser()
  if (error) return error

  const supabase = await createClient()

  // ── 1. Find the currently active account ─────────────────────────────────
  const { data: active } = await supabase
    .from('instagram_accounts')
    .select('ig_user_id, ig_username')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // ── 2. Fetch + decrypt stored session, then logout on Instagram ───────────
  try {
    const admin = createAdminClient()
    const { data: sessionRow } = await admin
      .from('instagram_session_events')
      .select('session_blob')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (sessionRow?.session_blob) {
      const session = JSON.parse(decrypt(sessionRow.session_blob)) as Record<string, unknown>
      // Best-effort — don't await failure; always proceed to disconnect record
      const logoutResult = await runInstagramCommand({ cmd: 'logout', session }, 15_000)
      console.log('[disconnect] logout result:', logoutResult.ok,
        'warning' in logoutResult ? logoutResult.warning : '')
    }
  } catch (logoutErr) {
    // Non-fatal — log and continue
    console.error('[disconnect] logout best-effort failed:', logoutErr)
  }

  // ── 3. Insert disconnect event (append-only) ──────────────────────────────
  const { error: insertError } = await supabase.from('instagram_accounts').insert({
    user_id: user.id,
    ig_user_id: active?.ig_user_id ?? null,
    ig_username: active?.ig_username ?? null,
    status: 'disconnected',
  })

  if (insertError) {
    console.error('[disconnect] DB insert error:', insertError.message)
    return NextResponse.json({ ok: false, error: 'Could not disconnect account.' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, message: 'Instagram account disconnected.' })
}
