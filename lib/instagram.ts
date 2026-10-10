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
  | { cmd: 'logout'; session: Record<string, unknown> }
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

export type IgErrorCode =
  | 'AUTH_FAILED'       // bad credentials
  | 'CHALLENGE'         // 2FA / verification code required
  | 'RATE_LIMITED'      // Instagram is throttling us
  | 'TIMEOUT'           // request timed out
  | 'WORKER_ERROR'      // infrastructure / internal error
  | 'UNKNOWN'           // unclassified

export interface IgFailure {
  ok: false
  /** Machine-readable code — safe to log and pass to the client */
  code: IgErrorCode
  /** Internal detail — log server-side only, never send to clients */
  _internalError?: string
  /** User-safe message derived from the code */
  error: string
  challenge_required?: boolean
}

/** Canonical user-facing messages keyed by error code */
const USER_MESSAGES: Record<IgErrorCode, string> = {
  AUTH_FAILED:   'Incorrect username or password.',
  CHALLENGE:     'Instagram requires a verification code.',
  RATE_LIMITED:  'Instagram is rate-limiting requests. Please wait 10–30 minutes and try again.',
  TIMEOUT:       'Instagram request timed out. Please try again.',
  WORKER_ERROR:  'Could not connect to Instagram right now. Please try again shortly.',
  UNKNOWN:       'Could not connect Instagram. Check your details and try again.',
}

/**
 * Map a raw error string returned by the Python worker into a typed IgFailure.
 * Only well-known patterns get a specific code; everything else → UNKNOWN / WORKER_ERROR.
 * The _internalError field preserves the raw string for server-side logging only.
 */
export function classifyIgError(
  rawError: string,
  opts: { challenge_required?: boolean; isInfra?: boolean } = {},
): IgFailure {
  if (opts.isInfra) {
    return { ok: false, code: 'WORKER_ERROR', error: USER_MESSAGES.WORKER_ERROR, _internalError: rawError }
  }

  const e = rawError.toLowerCase()
  let code: IgErrorCode = 'UNKNOWN'

  if (opts.challenge_required) {
    code = 'CHALLENGE'
  } else if (/bad password|bad credentials|incorrect.*password|wrong password|password.*incorrect/i.test(e)) {
    code = 'AUTH_FAILED'
  } else if (/rate.limit|throttl|429|please wait few minutes|wait.*minute/i.test(e)) {
    code = 'RATE_LIMITED'
  } else if (/challenge required|verification code|two.factor|2fa/i.test(e)) {
    code = 'CHALLENGE'
  } else if (/timed? out|timeout/i.test(e)) {
    code = 'TIMEOUT'
  } else if (/worker|unreachable|fetch|network|503|502|500/i.test(e)) {
    code = 'WORKER_ERROR'
  }

  return {
    ok: false,
    code,
    error: USER_MESSAGES[code],
    _internalError: rawError,
    ...(opts.challenge_required ? { challenge_required: true } : {}),
  }
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
  const baseUrl = workerUrl.replace(/\/+$/, '')
  const secret = process.env.WORKER_SECRET ?? ''

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Railway worker is POST /rpc. Vercel Python function is the endpoint itself (/api/ig).
  // Accept either the host or the full path so INSTAGRAM_API_URL can be set either way.
  const endpoint = baseUrl.endsWith('/api/ig') || baseUrl.endsWith('/rpc')
    ? baseUrl
    : `${baseUrl}/rpc`
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
      // Log full detail server-side — never sent to client
      console.error('[instagram.ts] worker non-OK status=%d body=%s', res.status, text.slice(0, 500))
      return classifyIgError(`Worker returned ${res.status}: ${text.slice(0, 200)}`, { isInfra: true })
    }

    const data = (await res.json()) as IgResponse
    if (!data.ok) {
      const raw = (data as IgFailure)._internalError ?? (data as IgFailure).error ?? 'unknown'
      console.error('[instagram.ts] worker returned ok=false raw=%s', raw)
      // Re-classify with our canonical codes so _internalError is always set
      return classifyIgError(raw, { challenge_required: (data as IgFailure).challenge_required })
    }
    console.log('[instagram.ts] worker result ok=true')
    return data
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[instagram.ts] worker fetch error:', msg)
    if (msg.toLowerCase().includes('abort')) {
      return classifyIgError(msg, { isInfra: true })
    }
    return classifyIgError(`Worker unreachable: ${msg}`, { isInfra: true })
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
      finish(classifyIgError('subprocess timed out', { isInfra: true }))
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (exitCode) => {
      clearTimeout(timer)
      if (stderr.trim()) {
        console.error('[instagram.ts stderr]', redactLog(stderr.trim()))
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) {
          console.error('[instagram.ts] no JSON in stdout exitCode=%d stdout=%s', exitCode, stdout.slice(0, 200))
          finish(classifyIgError('no JSON in subprocess output', { isInfra: true }))
          return
        }
        const parsed = JSON.parse(stdout.slice(jsonStart)) as IgResponse
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
          if (!parsed.ok) {
            const raw = (parsed as IgFailure).error ?? 'unknown'
            console.error('[instagram.ts] subprocess ok=false raw=%s', raw)
            finish(classifyIgError(raw, { challenge_required: (parsed as IgFailure).challenge_required }))
            return
          }
          finish(parsed)
          return
        }
        finish(classifyIgError('malformed subprocess response', { isInfra: true }))
      } catch (parseErr) {
        console.error('[instagram.ts] JSON parse error:', parseErr)
        finish(classifyIgError('JSON parse failed', { isInfra: true }))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      console.error('[instagram.ts] subprocess spawn error:', err)
      finish(classifyIgError(String(err), { isInfra: true }))
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
  // VERCEL_URL is the deployment-specific URL (e.g. mvp-abc123.vercel.app) which is
  // protected by Vercel SSO when Deployment Protection is enabled — it will 401.
  // VERCEL_PROJECT_PRODUCTION_URL is the stable production alias; also may be protected.
  // INSTAGRAM_API_URL should be set to the custom domain (e.g. https://search.agenticfruit.com/api/ig)
  // to bypass SSO protection entirely.
  const vercelInternalUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/ig`
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/ig`
    : null

  const workerUrl = process.env.INSTAGRAM_API_URL ?? vercelInternalUrl
  console.log('[instagram.ts] workerUrl=%s INSTAGRAM_API_URL=%s VERCEL_URL=%s VERCEL_PROJECT_PRODUCTION_URL=%s',
    workerUrl, process.env.INSTAGRAM_API_URL ?? '(unset)', process.env.VERCEL_URL ?? '(unset)', process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '(unset)')

  if (workerUrl) {
    return runViaHttp(payload, timeoutMs, workerUrl)
  }
  return runViaSubprocess(payload, timeoutMs)
}
