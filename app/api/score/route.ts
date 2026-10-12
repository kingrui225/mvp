import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scorePosts } from '@/lib/jev'
import type { PostResult } from '@/app/api/search/route'

export const maxDuration = 60

const MAX_POSTS = 200

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (!process.env.TYPESAFE_API_KEY) {
    return NextResponse.json({ error: 'Scoring is not configured: TYPESAFE_API_KEY is missing.' }, { status: 503 })
  }

  let body: { posts?: PostResult[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.posts)) return NextResponse.json({ error: 'posts array is required' }, { status: 400 })
  if (body.posts.length > MAX_POSTS) return NextResponse.json({ error: `max ${MAX_POSTS} posts` }, { status: 400 })

  return NextResponse.json(await scorePosts(body.posts))
}
