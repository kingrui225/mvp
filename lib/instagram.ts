/**
 * Server-only Instagram pipeline bridge.
 * Credentials are passed via stdin JSON and never written to argv or logs.
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

function redact(value: string): string {
  return value
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[redacted]"')
    .replace(/"code"\s*:\s*"[^"]*"/gi, '"code":"[redacted]"')
}

export function runInstagramCommand(payload: IgCommand, timeoutMs = 90_000): Promise<IgResponse> {
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

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (stderr.trim()) {
        console.error('[instagram.ts stderr]', stderr.trim())
      }
      try {
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) {
          console.error('[instagram.ts] no JSON in stdout:', stdout)
          finish({
            ok: false,
            error: 'Instagram request failed.',
          })
          return
        }
        const parsed = JSON.parse(stdout.slice(jsonStart)) as IgResponse
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
          finish(parsed)
          return
        }
        finish({ ok: false, error: 'Instagram request failed.' })
      } catch {
        finish({
          ok: false,
          error: code === 0 ? 'Instagram request failed.' : 'Instagram request failed.',
        })
      }
    })

    proc.on('error', () => {
      clearTimeout(timer)
      finish({ ok: false, error: 'Instagram request failed.' })
    })

    proc.stdin.write(JSON.stringify(payload))
    proc.stdin.end()

    void redact(stderr)
  })
}
