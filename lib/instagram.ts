/**
 * Server-only Instagram pipeline bridge.
 *
 * LOCAL DEV  — spawns instagram_search.py as a subprocess (stdin/stdout JSON-RPC).
 * PRODUCTION — calls the Python worker service over HTTP when INSTAGRAM_API_URL is set.
 *
 * Credentials are passed via the request body / stdin and are never logged.
 */
import { spawn } from 'child_process'
import path from 'path'

const REPO_ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd())
const SCRIPT_PATH = path.join(REPO_ROOT, 'instagram_search.py')

export type IgCommand =
  | { cmd: 'login'; username: string; password: string }
  | { cmd: 'browser_login'; timeout_seconds?: number }
  | { cmd: 'login_by_sessionid'; sessionid: string }
  | { cmd: 'challenge'; username: string; password: string; code: string }
  | { cmd: 'search'; query: string; search_type: string; limit: number; session?: Record<string, unknown> }

export interface IgSuccess {
  ok: true
  username?: string
  user_id?: string
  session?: Record<string, unknown>
  query?: string
  search_type?: string
  limit?: number
  results?: unknown[]
}

export interface IgFailure {
  ok: false
  error: string
  challenge_required?: boolean
}

export type IgResponse = IgSuccess | IgFailure

function redactLog(value: string): string {
  return value
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[redacted]"')
    .replace(/"code"\s*:\s*"[^"]*"/gi, '"code":"[redacted]"')
    .replace(/"sessionid"\s*:\s*"[^"]*"/gi, '"sessionid":"[redacted]"')
}

// ─── HTTP mode (production / Vercel) ────────────────────────────────────────

async function runViaHttp(payload: IgCommand, timeoutMs: number, workerUrl: string): Promise<IgResponse> {
  const baseUrl = workerUrl.replace(/\/$/, '')
  const secret = process.env.WORKER_SECRET ?? ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Railway worker uses /rpc; Vercel Python function is the endpoint itself
  const endpoint = baseUrl.endsWith('/api/ig') ? baseUrl : `${baseUrl}/rpc`
  const hasSecret = secret.length > 0
  console.log('[instagram.ts] HTTP mode cmd=%s endpoint=%s hasSecret=%s', payload.cmd, endpoint, hasSecret)

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-Secret': secret,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })

    console.log('[instagram.ts] worker response status=%d', res.status)

    if (!res.ok) {
      const text = await res.text()
      console.error('[instagram.ts] worker non-OK body=%s', text.slice(0, 300))
      return { ok: false, error: `Worker returned ${res.status}: ${text.slice(0, 200)}` }
    }

    const data = (await res.json()) as IgResponse
    console.log('[instagram.ts] worker result ok=%s error=%s', data.ok, (data as IgFailure).error)
    return data
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[instagram.ts] worker fetch error:', msg)
    if (msg.includes('abort') || msg.includes('AbortError')) {
      return { ok: false, error: 'Instagram request timed out.' }
    }
    return { ok: false, error: `Worker unreachable: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Subprocess mode (local dev) ────────────────────────────────────────────

function runViaSubprocess(payload: IgCommand, timeoutMs: number): Promise<IgResponse> {
  return new Promise((resolve) => {
    const proc = spawn('python3', [SCRIPT_PATH, '--json-rpc'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: IgResponse) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      finish({ ok: false, error: 'Instagram request timed out.' })
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (stderr.trim()) {
        console.error('[instagram.ts stderr]', redactLog(stderr.trim()))
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) {
          console.error('[instagram.ts] no JSON in stdout:', stdout)
          finish({ ok: false, error: 'Instagram request failed.' })
          return
        }
        const parsed = JSON.parse(stdout.slice(jsonStart)) as IgResponse
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
          finish(parsed)
          return
        }
        finish({ ok: false, error: 'Instagram request failed.' })
      } catch {
        finish({ ok: false, error: code === 0 ? 'Instagram request failed.' : 'Instagram request failed.' })
      }
    })

    proc.on('error', () => {
      clearTimeout(timer)
      finish({ ok: false, error: 'Instagram request failed.' })
    })

    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()
  })
}

// ─── Public entry point ──────────────────────────────────────────────────────

export function runInstagramCommand(payload: IgCommand, timeoutMs = 90_000): Promise<IgResponse> {
  // VERCEL=1 is set automatically by Vercel in all serverless environments.
  // INSTAGRAM_API_URL can also be set explicitly (e.g. for Railway worker).
  // VERCEL_URL is set automatically by Vercel (no protocol, no trailing slash).
  // INSTAGRAM_API_URL overrides everything (e.g. Railway worker).
  const vercelInternalUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/ig`
    : null

  const workerUrl = process.env.INSTAGRAM_API_URL ?? vercelInternalUrl

  if (workerUrl) {
    return runViaHttp(payload, timeoutMs, workerUrl)
  }
  return runViaSubprocess(payload, timeoutMs)
}
