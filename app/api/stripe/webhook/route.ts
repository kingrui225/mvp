import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { getStripe } from '@/lib/stripe'

export const runtime = 'nodejs'

function periodEnd(sub: Stripe.Subscription): string | null {
  const value = (sub as Stripe.Subscription & { current_period_end?: number }).current_period_end
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : null
}

async function resolveUserId(admin: ReturnType<typeof createAdminClient>, event: Stripe.Event): Promise<string | null> {
  const obj = event.data.object as { metadata?: Record<string, string>; customer?: string; client_reference_id?: string }
  if (obj.metadata?.supabase_user_id) return obj.metadata.supabase_user_id
  if (obj.client_reference_id) return obj.client_reference_id

  const customerId = typeof obj.customer === 'string' ? obj.customer : null
  if (!customerId) return null

  const { data } = await admin
    .from('billing_events')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .not('user_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  return data?.user_id ?? null
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Webhook is not configured.' }, { status: 500 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  }

  const rawBody = await req.text()
  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(rawBody, signature, secret)
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error: receiptError } = await admin.from('webhook_receipts').insert({
    stripe_event_id: event.id,
  })

  if (receiptError) {
    if (receiptError.code === '23505') {
      return NextResponse.json({ received: true, duplicate: true })
    }
    return NextResponse.json({ error: 'Could not record webhook' }, { status: 500 })
  }

  const userId = await resolveUserId(admin, event)
  const object = event.data.object as Stripe.Subscription | Stripe.Checkout.Session | Stripe.Customer
  const customerId =
    'customer' in object && typeof object.customer === 'string'
      ? object.customer
      : object.id.startsWith('cus_')
        ? object.id
        : null

  let subscription: Stripe.Subscription | null = null
  if (event.type.startsWith('customer.subscription.') && 'status' in object) {
    subscription = object as Stripe.Subscription
  } else if (event.type === 'checkout.session.completed') {
    const session = object as Stripe.Checkout.Session
    if (typeof session.subscription === 'string') {
      subscription = await getStripe().subscriptions.retrieve(session.subscription)
    }
  }

  await admin.from('billing_events').insert({
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_event_id: event.id,
    stripe_event_type: event.type,
    subscription_id: subscription?.id ?? null,
    subscription_status: subscription?.status ?? null,
    price_id: subscription?.items.data[0]?.price.id ?? null,
    current_period_end: subscription ? periodEnd(subscription) : null,
    payload: {
      type: event.type,
      id: event.id,
      customer: customerId,
      subscription: subscription?.id ?? null,
      status: subscription?.status ?? null,
    },
  })

  if (userId && customerId) {
    const { error: mapError } = await admin.from('stripe_customer_events').insert({
      user_id: userId,
      stripe_customer_id: customerId,
    })
    if (mapError && mapError.code !== '23505') {
      return NextResponse.json({ error: 'Could not map customer' }, { status: 500 })
    }
  }

  return NextResponse.json({ received: true })
}
