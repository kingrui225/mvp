/**
 * SERVICE-ROLE Supabase client — bypasses RLS.
 * NEVER import this in Client Components or expose to the browser.
 * Use only in server-side Route Handlers that require elevated access
 * (e.g. webhook processing, admin migration scripts).
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js'

let _adminClient: ReturnType<typeof createSupabaseClient> | null = null

export function createAdminClient() {
  if (!_adminClient) {
    _adminClient = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )
  }
  return _adminClient
}
