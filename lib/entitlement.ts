import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const ACTIVE_STATUSES = new Set(['active', 'trialing'])

export async function hasActiveSubscription(userId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('billing_events')
    .select('subscription_status, current_period_end')
    .eq('user_id', userId)
    .like('stripe_event_type', 'customer.subscription%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (data && ACTIVE_STATUSES.has(data.subscription_status ?? '')) {
    if (!data.current_period_end) return true
    return new Date(data.current_period_end).getTime() > Date.now()
  }

  // Fallback for service-role writes that the user view may not yet expose
  const admin = createAdminClient()
  const { data: latest } = await admin
    .from('billing_events')
    .select('subscription_status, current_period_end')
    .eq('user_id', userId)
    .like('stripe_event_type', 'customer.subscription%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latest) return false
  if (!ACTIVE_STATUSES.has(latest.subscription_status ?? '')) return false
  if (!latest.current_period_end) return true
  return new Date(latest.current_period_end).getTime() > Date.now()
}
