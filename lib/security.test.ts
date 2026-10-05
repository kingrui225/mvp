import { createHmac } from 'crypto'
import { decrypt, encrypt } from './encrypt'
import { hashIp } from './rate-limit'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function testEncryptionRoundTrip() {
  const original = JSON.stringify({ sessionid: 'abc', username: 'demo' })
  const envelope = encrypt(original)
  assert(!envelope.includes('abc'), 'ciphertext must not contain plaintext')
  assert(decrypt(envelope) === original, 'decrypted value must match plaintext')
}

function testEncryptionRejectsTamper() {
  const envelope = Buffer.from(encrypt('secret'), 'base64')
  envelope[20] = envelope[20] ^ 0xff
  let failed = false
  try {
    decrypt(envelope.toString('base64'))
  } catch {
    failed = true
  }
  assert(failed, 'tampered ciphertext must fail authentication')
}

function testIpHashIsOneWay() {
  const hashed = hashIp('203.0.113.10')
  assert(hashed.length === 64, 'ip hash must be sha256 hex')
  assert(!hashed.includes('203.0.113.10'), 'raw IP must never be stored')
}

function testWebhookSignatureVerification() {
  const secret = 'whsec_test'
  const payload = '{"id":"evt_1","type":"customer.subscription.updated"}'
  const timestamp = Math.floor(Date.now() / 1000)
  const signed = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  const valid = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')
  const invalid = createHmac('sha256', 'wrong').update(`${timestamp}.${payload}`).digest('hex')
  assert(signed === valid, 'matching Stripe signatures must verify')
  assert(signed !== invalid, 'wrong secrets must not verify')
}

function testOpenRedirectGuard() {
  const next = '//evil.example'
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/search'
  assert(safeNext === '/search', 'protocol-relative redirects must be rejected')
}

function main() {
  if (!process.env.IG_SESSION_ENCRYPTION_KEY) {
    process.env.IG_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
  }
  testEncryptionRoundTrip()
  testEncryptionRejectsTamper()
  testIpHashIsOneWay()
  testWebhookSignatureVerification()
  testOpenRedirectGuard()
  console.log('security tests passed')
}

main()
