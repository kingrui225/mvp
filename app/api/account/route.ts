/**
 * /api/account — app-level account info (Supabase user).
 * This route returns the authenticated Supabase user's profile.
 * Instagram account management is handled separately via /api/instagram/*.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'

/** GET /api/account — returns the current Supabase user profile */
export async function GET() {
  const { user, error } = await requireUser()
  if (error) return error

  return NextResponse.json({
    id: user.id,
    email: user.email ?? null,
  })
}
