/**
 * DELETE /api/instagram/disconnect
 *
 * Append-only disconnect: inserts a new row in instagram_accounts with
 * status='disconnected'. Never deletes or updates existing rows.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function DELETE() {
  const { user, error } = await requireUser()
  if (error) return error

  const supabase = await createClient()

  // Find the currently active account for this user.
  const { data: active } = await supabase
    .from('instagram_accounts')
    .select('ig_user_id, ig_username')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Insert a disconnected event. If no active account, still succeeds idempotently.
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
