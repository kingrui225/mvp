/**
 * Browser-side Supabase client.
 * Use this only in Client Components ('use client').
 * Each call returns a new client instance bound to the current browser cookies.
 */
import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
