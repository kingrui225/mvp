import fs from 'fs'
import path from 'path'
import { NextResponse } from 'next/server'

const SESSION_FILE = path.join(process.cwd(), 'session.json')

export interface AccountStatus {
  connected: boolean
  username: string | null
  user_id: string | null
  created_at: string | null
}

function readSession(): AccountStatus {
  try {
    if (!fs.existsSync(SESSION_FILE)) {
      return { connected: false, username: null, user_id: null, created_at: null }
    }
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'))

    // username is stored at the top level (added by persist_device_settings)
    const username: string | null = raw.username ?? null

    // ds_user_id lives in instagrapi_settings.authorization_data
    const user_id: string | null =
      raw.instagrapi_settings?.authorization_data?.ds_user_id ?? null

    const created_at: string | null = raw.created_at ?? null

    return {
      connected: !!(username || user_id),
      username,
      user_id,
      created_at,
    }
  } catch {
    return { connected: false, username: null, user_id: null, created_at: null }
  }
}

/** GET /api/account — returns the current connected Instagram account info */
export async function GET() {
  return NextResponse.json(readSession())
}

/** DELETE /api/account — disconnects the account by removing session.json */
export async function DELETE() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      fs.unlinkSync(SESSION_FILE)
    }
    return NextResponse.json({ ok: true, message: 'Account disconnected.' })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
