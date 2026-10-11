'use client'

import { AtSign, Globe, Hash, KeyRound, X } from 'lucide-react'
import { FormEvent, useEffect, useRef, useState } from 'react'

export interface InstagramStatus {
  connected: boolean
  username: string | null
  user_id: string | null
  created_at: string | null
}

interface Props {
  open: boolean
  onClose: () => void
  account: InstagramStatus | null
  onChanged: (next: InstagramStatus) => void
}

// Browser login (Selenium) is only available in local dev — not on Vercel.
const BROWSER_LOGIN_AVAILABLE = process.env.NEXT_PUBLIC_BROWSER_LOGIN === 'true'
const CHALLENGE_POLL_TIMEOUT_MS = 300_000
const CHALLENGE_POLL_INTERVAL_MS = 6_000

type ConnectMethod = 'browser' | 'credentials' | 'sessionid'
type VerificationMethod = 'email' | 'sms' | 'totp' | 'app' | 'unknown'

const METHOD_LABEL: Record<VerificationMethod, string> = {
  email: 'an email code',
  sms: 'a text-message code',
  totp: 'an authenticator code',
  app: 'an approval in the Instagram app',
  unknown: 'a confirmation Instagram did not name',
}

function verificationHint(methods: VerificationMethod[]): string {
  const named = methods.map((method) => METHOD_LABEL[method]).join(' and ')
  return `Instagram is asking for ${named}. This screen keeps checking for an in-app approval, and you can enter a code if you received one.`
}

function asMethods(value: unknown): VerificationMethod[] {
  if (!Array.isArray(value)) return ['unknown']
  const methods = value.filter((method): method is VerificationMethod =>
    method === 'email' || method === 'sms' || method === 'totp' || method === 'app' || method === 'unknown'
  )
  return methods.length ? methods : ['unknown']
}

export function ConnectedAccountsModal({ open, onClose, account, onChanged }: Props) {
  const [method, setMethod] = useState<ConnectMethod>('credentials')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [sessionid, setSessionid] = useState('')
  const [challengeRequired, setChallengeRequired] = useState(false)
  const [verificationMethods, setVerificationMethods] = useState<VerificationMethod[]>(['unknown'])
  const [checking, setChecking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  useEffect(() => {
    if (!open) {
      setUsername('')
      setPassword('')
      setCode('')
      setSessionid('')
      setChallengeRequired(false)
      setVerificationMethods(['unknown'])
      setChecking(false)
      setError(null)
      setMethod('credentials')
    }
  }, [open])

  useEffect(() => {
    if (!open || !challengeRequired || method !== 'credentials' || !username || !password) return
    let stopped = false
    const started = Date.now()

    const check = async () => {
      if (stopped) return
      if (Date.now() - started > CHALLENGE_POLL_TIMEOUT_MS) {
        stopped = true
        setChecking(false)
        setError('Instagram approval timed out. Approve in the app, then click Check again or enter the code.')
        return
      }
      setChecking(true)
      try {
        const res = await fetch('/api/instagram/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ method: 'check', username, password }),
        })
        const data = await res.json()
        if (stopped) return
        if (data.ok) {
          stopped = true
          setPassword('')
          setCode('')
          setChallengeRequired(false)
          const status = await fetch('/api/instagram/status').then((r) => r.json())
          onChangedRef.current(status)
          return
        }
        if (data.challenge_required) {
          setVerificationMethods(asMethods(data.verification_methods))
        }
      } catch {
        // Keep checking. A single network miss should not stop the approval watch.
      } finally {
        if (!stopped) setChecking(false)
      }
    }

    const first = setTimeout(check, 2000)
    const timer = setInterval(check, CHALLENGE_POLL_INTERVAL_MS)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [open, challengeRequired, method, username, password])

  if (!open) return null

  async function refreshStatus() {
    const res = await fetch('/api/instagram/status')
    const data = await res.json()
    onChanged(data)
  }

  async function handleBrowserConnect() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/instagram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'browser' }),
      })
      const data = await res.json()
      if (!res.ok || data.ok === false) {
        setError(data.error ?? 'Could not connect Instagram.')
        return
      }
      await refreshStatus()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleCredentialsConnect(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const submittingCode = challengeRequired && code.trim().length > 0
      const endpoint = submittingCode ? '/api/instagram/challenge' : '/api/instagram/connect'
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          submittingCode
            ? { username, password, code }
            : { method: challengeRequired ? 'check' : undefined, username, password }
        ),
      })
      const data = await res.json()
      if (data.challenge_required) {
        setVerificationMethods(asMethods(data.verification_methods ?? [data.verification_method]))
        setChallengeRequired(true)
        setError(null)
        return
      }
      if (!res.ok || data.ok === false) {
        setError(data.error ?? 'Could not connect Instagram.')
        return
      }
      setPassword('')
      setCode('')
      await refreshStatus()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSessionIdConnect(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/instagram/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'sessionid', sessionid }),
      })
      const data = await res.json()
      if (!res.ok || data.ok === false) {
        setError(data.error ?? 'Could not connect Instagram.')
        return
      }
      setSessionid('')
      await refreshStatus()
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDisconnect() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/instagram/disconnect', { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok || data.ok === false) {
        setError(data.error ?? 'Could not disconnect Instagram.')
        return
      }
      onChanged({ connected: false, username: null, user_id: null, created_at: null })
    } catch {
      setError('Could not reach the server. Check your connection and try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connected-accounts-title"
        className="w-full max-w-md rounded-2xl border border-[#e1e5ea] bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[#edf0f3] px-5 py-4">
          <div>
            <h2 id="connected-accounts-title" className="text-sm font-semibold text-[#17202b]">
              Connected accounts
            </h2>
            <p className="mt-0.5 text-xs text-[#8994a1]">Manage social accounts used for search.</p>
          </div>
          <button onClick={onClose} className="text-[#b0b8c1] transition hover:text-[#657180]">
            <X className="size-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <div className="flex items-center gap-3 rounded-xl border border-[#edf0f3] bg-[#f8f9fb] px-3 py-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#f9ce34] via-[#ee2a7b] to-[#6228d7]">
              <AtSign className="size-4 text-white" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[#273442]">Instagram</p>
              <p className="truncate text-xs text-[#8994a1]">
                {account?.connected
                  ? `@${account.username ?? account.user_id ?? 'connected'}`
                  : 'Not connected'}
              </p>
            </div>
            {account?.connected && (
              <button
                onClick={handleDisconnect}
                disabled={loading}
                className="rounded-lg border border-[#e1e5ea] bg-white px-2.5 py-1 text-xs font-semibold text-[#657180] hover:text-[#e53e3e] disabled:opacity-50"
              >
                Disconnect
              </button>
            )}
          </div>

          {!account?.connected && (
            <div className="mt-4 flex flex-col gap-3">

              {/* ── Credentials panel (default) ───────────────────────────── */}
              {method === 'credentials' && (
                <form onSubmit={handleCredentialsConnect} autoComplete="off" className="flex flex-col gap-3">
                  <div className="rounded-xl border border-[#e8ecf0] bg-[#f8f9fb] px-3.5 py-2.5 text-xs text-[#657180] leading-relaxed">
                    <span className="font-semibold text-[#273442]">Security note: </span>
                    Your password is sent over HTTPS and used only once to create a session token — it is never stored.
                    The session token is encrypted before saving and expires after 30 days.
                    You can revoke access at any time by disconnecting here or logging out of Instagram in your browser.
                  </div>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Instagram username"
                    autoComplete="off"
                    readOnly
                    onFocus={(e) => e.currentTarget.removeAttribute('readonly')}
                    required
                    className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm outline-none focus:border-[#17202b] focus:bg-white"
                  />
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Instagram password"
                    autoComplete="off"
                    readOnly
                    onFocus={(e) => e.currentTarget.removeAttribute('readonly')}
                    required
                    className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm outline-none focus:border-[#17202b] focus:bg-white"
                  />
                  {challengeRequired && (
                    <p className="rounded-xl border border-[#e1e5ea] bg-[#f8f9fb] px-3.5 py-2.5 text-xs leading-relaxed text-[#657180]">
                      {verificationHint(verificationMethods)}
                      {checking && <span className="mt-1 block text-[#8994a1]">Checking Instagram…</span>}
                    </p>
                  )}
                  {challengeRequired && (
                    <input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="Code, if Instagram sent one"
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm outline-none focus:border-[#17202b] focus:bg-white"
                    />
                  )}
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-2 rounded-xl bg-[#17202b] py-2.5 text-sm font-semibold text-white transition hover:bg-[#2b3948] disabled:opacity-60"
                  >
                    {loading ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <KeyRound className="size-4" />
                    )}
                    {loading ? 'Connecting…' : challengeRequired ? (code.trim() ? 'Verify code' : 'Check again') : 'Connect Instagram'}
                  </button>
                </form>
              )}

              {/* ── Session ID panel ──────────────────────────────────────── */}
              {method === 'sessionid' && (
                <form onSubmit={handleSessionIdConnect} className="flex flex-col gap-3">
                  <div className="rounded-xl border border-[#e1e5ea] bg-[#f8f9fb] px-3.5 py-3 text-xs text-[#657180] leading-relaxed">
                    <p className="font-semibold text-[#273442] mb-1">How to get your Session ID</p>
                    <ol className="list-decimal list-inside space-y-1">
                      <li>Open Instagram in Chrome and make sure you&apos;re logged in</li>
                      <li>Press <span className="font-mono bg-white border border-[#e1e5ea] rounded px-1">F12</span> → Application → Cookies → <span className="font-mono">instagram.com</span></li>
                      <li>Copy the value of the <span className="font-mono bg-white border border-[#e1e5ea] rounded px-1">sessionid</span> cookie</li>
                    </ol>
                  </div>
                  <input
                    value={sessionid}
                    onChange={(e) => setSessionid(e.target.value)}
                    placeholder="Paste sessionid cookie value"
                    autoComplete="off"
                    required
                    className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm font-mono outline-none focus:border-[#17202b] focus:bg-white"
                  />
                  <button
                    type="submit"
                    disabled={loading}
                    className="flex items-center justify-center gap-2 rounded-xl bg-[#17202b] py-2.5 text-sm font-semibold text-white transition hover:bg-[#2b3948] disabled:opacity-60"
                  >
                    {loading ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    ) : (
                      <Hash className="size-4" />
                    )}
                    {loading ? 'Connecting…' : 'Connect with Session ID'}
                  </button>
                  <p className="text-xs text-[#8994a1] leading-relaxed">
                    <span className="font-semibold text-[#657180]">Security: </span>
                    The session ID grants full account access. It is encrypted before storage, never logged, and expires after 30 days.
                    Disconnecting here also invalidates it on Instagram&apos;s servers.
                  </p>
                </form>
              )}

              {/* ── Browser login panel (local dev only) ─────────────────── */}
              {method === 'browser' && (
                <>
                  {loading ? (
                    <div className="flex flex-col items-center gap-3 rounded-xl border border-[#e1e5ea] bg-[#f8f9fb] px-4 py-5 text-center">
                      <div className="size-5 animate-spin rounded-full border-2 border-[#d9dfe6] border-t-[#17202b]" />
                      <div>
                        <p className="text-sm font-semibold text-[#17202b]">Chrome is open</p>
                        <p className="mt-0.5 text-xs text-[#8994a1]">Log in to Instagram in the browser window,<br />then come back here — we&apos;ll detect it automatically.</p>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={handleBrowserConnect}
                      disabled={loading}
                      className="flex items-center justify-center gap-2 rounded-xl bg-[#17202b] py-2.5 text-sm font-semibold text-white transition hover:bg-[#2b3948] disabled:opacity-60"
                    >
                      <Globe className="size-4" />
                      Open Browser to Connect
                    </button>
                  )}
                  <p className="text-center text-xs text-[#8994a1]">
                    A Chrome window opens. Log in normally — your password is never seen or stored by us.
                  </p>
                </>
              )}

              {/* ── Error display ─────────────────────────────────────────── */}
              {error && (
                <p className="rounded-lg border border-[#f5c6c6] bg-[#fff5f5] px-3 py-2 text-xs text-[#9b2c2c]">
                  {error}
                </p>
              )}

              {/* ── Other options (secondary) ─────────────────────────────── */}
              <div className="flex items-center justify-center gap-3 pt-1">
                {method !== 'sessionid' && (
                  <button
                    onClick={() => { setMethod('sessionid'); setError(null) }}
                    className="flex items-center gap-1 text-xs text-[#8994a1] hover:text-[#657180] transition"
                  >
                    <Hash className="size-3" />
                    Use Session ID
                  </button>
                )}
                {method !== 'credentials' && (
                  <button
                    onClick={() => { setMethod('credentials'); setError(null); setChallengeRequired(false); setVerificationMethods(['unknown']) }}
                    className="flex items-center gap-1 text-xs text-[#8994a1] hover:text-[#657180] transition"
                  >
                    <KeyRound className="size-3" />
                    Use Password
                  </button>
                )}
                {BROWSER_LOGIN_AVAILABLE && method !== 'browser' && (
                  <button
                    onClick={() => { setMethod('browser'); setError(null) }}
                    className="flex items-center gap-1 text-xs text-[#8994a1] hover:text-[#657180] transition"
                  >
                    <Globe className="size-3" />
                    Use Browser
                  </button>
                )}
              </div>
            </div>
          )}

          {account?.connected && error && (
            <p className="mt-3 rounded-lg border border-[#f5c6c6] bg-[#fff5f5] px-3 py-2 text-xs text-[#9b2c2c]">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
