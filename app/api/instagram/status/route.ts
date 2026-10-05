import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const { user, error } = await requireUser()
  if (error) return error

  const supabase = await createClient()
  const { data } = await supabase
    .from('instagram_accounts')
    .select('ig_user_id, ig_username, status, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    connected: data?.status === 'active',
    username: data?.status === 'active' ? data.ig_username ?? null : null,
    user_id: data?.status === 'active' ? data.ig_user_id ?? null : null,
    created_at: data?.created_at ?? null,
  })
}
