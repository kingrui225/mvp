/**
 * AES-256-GCM encryption utilities for sensitive blobs (e.g. Instagram session).
 *
 * Key is read from IG_SESSION_ENCRYPTION_KEY env (base64-encoded 32 bytes).
 * The output envelope format: base64( version(1) | iv(12) | tag(16) | ciphertext )
 *
 * Rules:
 *  - NEVER log plaintext or ciphertext outside of this module.
 *  - NEVER expose the key to the browser.
 *  - Increment KEY_VERSION if you rotate the key so old blobs can still be decrypted.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const KEY_VERSION = 1
const ALGORITHM = 'aes-256-gcm'

function getKey(): Buffer {
  const raw = process.env.IG_SESSION_ENCRYPTION_KEY
  if (!raw) throw new Error('IG_SESSION_ENCRYPTION_KEY is not set')
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new Error('IG_SESSION_ENCRYPTION_KEY must be 32 bytes (base64-encoded)')
  return key
}

/**
 * Encrypt a plaintext string.
 * Returns a base64-encoded envelope containing version, IV, auth tag, and ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // Envelope: [version(1)] [iv(12)] [tag(16)] [ciphertext(N)]
  const envelope = Buffer.concat([
    Buffer.from([KEY_VERSION]),
    iv,
    tag,
    encrypted,
  ])

  return envelope.toString('base64')
}

/**
 * Decrypt an envelope produced by encrypt().
 * Throws if the envelope is malformed, the tag is invalid, or the key is wrong.
 */
export function decrypt(envelope: string): string {
  const key = getKey()
  const buf = Buffer.from(envelope, 'base64')

  if (buf.length < 1 + 12 + 16 + 1) {
    throw new Error('Ciphertext envelope is too short')
  }

  // const version = buf[0] // reserved for future key rotation
  const iv = buf.subarray(1, 13)
  const tag = buf.subarray(13, 29)
  const ciphertext = buf.subarray(29)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return decrypted.toString('utf8')
}
