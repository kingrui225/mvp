/**
 * /auth/callback — Supabase email-link and OAuth exchange.
 * Receives `code` from Supabase, exchanges it for a session, then redirects.
 */
import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/search'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Ensure next is a relative path to prevent open-redirect attacks.
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/search'
      return NextResponse.redirect(`${origin}${safeNext}`)
    }
  }

  // Exchange failed — redirect to login with an error hint.
  return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`)
}
