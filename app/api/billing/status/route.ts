import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { hasActiveSubscription } from '@/lib/entitlement'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const { user, error } = await requireUser()
  if (error) return error

  const supabase = await createClient()
  const { data } = await supabase
    .from('billing_events')
    .select('subscription_status, current_period_end')
    .eq('user_id', user.id)
    .like('stripe_event_type', 'customer.subscription%')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: customer } = await supabase
    .from('stripe_customer_events')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const active = await hasActiveSubscription(user.id)
  return NextResponse.json({
    active,
    status: data?.subscription_status ?? null,
    current_period_end: data?.current_period_end ?? null,
    has_customer: Boolean(customer?.stripe_customer_id),
  })
}
