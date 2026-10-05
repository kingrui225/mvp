/**
 * Append-only rate limiting for sensitive Instagram auth endpoints.
 * Stores hashed IPs only; never raw addresses.
 */
import { createHash } from 'crypto'
import { createAdminClient } from '@/lib/supabase/admin'

const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS_PER_USER = 8
const MAX_ATTEMPTS_PER_IP = 20
const LOCKOUT_FAILURES = 5
const LOCKOUT_MS = 30 * 60 * 1000

export type RateLimitAction = 'ig_connect' | 'ig_challenge'

export function hashIp(ip: string | null | undefined): string {
  const value = (ip ?? 'unknown').split(',')[0].trim()
  return createHash('sha256').update(value).digest('hex')
}

export function clientIp(headers: Headers): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    headers.get('x-real-ip') ||
    'unknown'
  )
}

export async function checkRateLimit(opts: {
  userId: string
  ipHash: string
  action: RateLimitAction
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const admin = createAdminClient()
  const since = new Date(Date.now() - WINDOW_MS).toISOString()
  const lockoutSince = new Date(Date.now() - LOCKOUT_MS).toISOString()

  const { data: recent } = await admin
    .from('rate_limit_events')
    .select('user_id, ip_hash, success, created_at')
    .eq('action', opts.action)
    .gte('created_at', lockoutSince)

  const rows = recent ?? []
  const userRows = rows.filter((r) => r.user_id === opts.userId)
  const ipRows = rows.filter((r) => r.ip_hash === opts.ipHash)
  const windowUser = userRows.filter((r) => r.created_at >= since)
  const windowIp = ipRows.filter((r) => r.created_at >= since)
  const recentFailures = userRows.filter((r) => r.success === false)

  if (recentFailures.length >= LOCKOUT_FAILURES) {
    return {
      ok: false,
      status: 429,
      error: 'Too many attempts. Please wait before trying again.',
    }
  }

  if (windowUser.length >= MAX_ATTEMPTS_PER_USER || windowIp.length >= MAX_ATTEMPTS_PER_IP) {
    return {
      ok: false,
      status: 429,
      error: 'Too many attempts. Please wait before trying again.',
    }
  }

  return { ok: true }
}

export async function recordRateLimit(opts: {
  userId: string
  ipHash: string
  action: RateLimitAction
  success: boolean
}): Promise<void> {
  const admin = createAdminClient()
  await admin.from('rate_limit_events').insert({
    user_id: opts.userId,
    ip_hash: opts.ipHash,
    action: opts.action,
    success: opts.success,
  })
}
