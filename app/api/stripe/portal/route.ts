import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { appUrl, getStripe } from '@/lib/stripe'

export async function POST() {
  const { user, error } = await requireUser()
  if (error) return error

  const supabase = await createClient()
  const { data: mapped } = await supabase
    .from('stripe_customer_events')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!mapped?.stripe_customer_id) {
    return NextResponse.json({ error: 'No billing account found.' }, { status: 404 })
  }

  const portal = await getStripe().billingPortal.sessions.create({
    customer: mapped.stripe_customer_id,
    return_url: `${appUrl()}/search`,
  })

  return NextResponse.json({ url: portal.url })
}
