import Stripe from 'stripe'

let stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY is not set')
    stripe = new Stripe(key)
  }
  return stripe
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

export function stripePriceId(): string {
  return process.env.STRIPE_PRICE_ID ?? process.env.STRIPE_PRICE_ID_WHATSAPP_STUDIO ?? ''
}
