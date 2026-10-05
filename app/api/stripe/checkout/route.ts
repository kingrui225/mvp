import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { appUrl, getStripe, stripePriceId } from '@/lib/stripe'

export async function POST() {
  const { user, error } = await requireUser()
  if (error) return error

  const priceId = stripePriceId()
  if (!priceId) {
    return NextResponse.json({ error: 'Billing is not configured.' }, { status: 500 })
  }

  const supabase = await createClient()
  const { data: mapped } = await supabase
    .from('stripe_customer_events')
    .select('stripe_customer_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const stripe = getStripe()
  let customerId = mapped?.stripe_customer_id ?? null
  const admin = createAdminClient()

  if (!customerId) {
    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', user.id)
      .maybeSingle()

    const customer = await stripe.customers.create({
      email: user.email ?? profile?.email ?? undefined,
      metadata: { supabase_user_id: user.id },
    })
    customerId = customer.id

    await admin.from('stripe_customer_events').insert({
      user_id: user.id,
      stripe_customer_id: customerId,
    })
    await admin.from('billing_events').insert({
      user_id: user.id,
      stripe_customer_id: customerId,
      stripe_event_id: `local_customer_${customerId}`,
      stripe_event_type: 'customer.created.local',
      payload: { customer_id: customerId },
    })
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${appUrl()}/search?checkout=success`,
    cancel_url: `${appUrl()}/search?checkout=cancel`,
    client_reference_id: user.id,
    metadata: { supabase_user_id: user.id },
    allow_promotion_codes: true,
  })

  return NextResponse.json({ url: session.url })
}
