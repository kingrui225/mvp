/**
 * GET /api/transcripts/signed-url?path={storage_path}&expires={seconds}
 *
 * Generates a short-lived signed URL for a reel artifact (MP3 or transcript JSON)
 * stored in the private `reel-artifacts` Supabase Storage bucket.
 *
 * Security:
 *  - Requires authenticated user.
 *  - Path must start with the requesting user's UUID (first path segment).
 *  - Expiry is capped at 24 hours regardless of the `expires` query param.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

const BUCKET = 'reel-artifacts'
const MAX_EXPIRY_SECONDS = 86_400  // 24 hours

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const path = searchParams.get('path')
  const expiresRaw = parseInt(searchParams.get('expires') ?? '3600', 10)
  const expiresIn = Math.min(Math.max(expiresRaw, 60), MAX_EXPIRY_SECONDS)

  if (!path) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 })
  }

  // Security: the first segment of the storage path must be the requesting user's ID.
  const firstSegment = path.split('/')[0]
  if (firstSegment !== user.id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, expiresIn)

  if (error || !data?.signedUrl) {
    console.error('[signed-url] createSignedUrl error:', error?.message)
    return NextResponse.json({ error: 'Could not generate signed URL' }, { status: 500 })
  }

  return NextResponse.json({
    url: data.signedUrl,
    expires_in: expiresIn,
    path,
  })
}
