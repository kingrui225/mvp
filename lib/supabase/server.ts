/**
 * Server-side Supabase client (Route Handlers, Server Actions, middleware).
 * Reads/writes cookies via Next.js headers() / cookies().
 * Uses the ANON key — respects Row Level Security.
 */
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // setAll is called from a Server Component; cookies are
            // already committed so this is safe to swallow.
          }
        },
      },
    },
  )
}
