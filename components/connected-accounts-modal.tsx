'use client'

import { AtSign, Globe, X } from 'lucide-react'
import { useEffect, useState } from 'react'

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

export function ConnectedAccountsModal({ open, onClose, account, onChanged }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setError(null)
    }
  }, [open])

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
      setError('Network error — could not reach the server.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDisconnect() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/account', { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok || data.ok === false) {
        setError(data.error ?? 'Could not disconnect Instagram.')
        return
      }
      onChanged({ connected: false, username: null, user_id: null, created_at: null })
    } catch {
      setError('Network error — could not reach the server.')
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
              {loading ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-[#e1e5ea] bg-[#f8f9fb] px-4 py-5 text-center">
                  <div className="size-5 animate-spin rounded-full border-2 border-[#d9dfe6] border-t-[#17202b]" />
                  <div>
                    <p className="text-sm font-semibold text-[#17202b]">Chrome is open</p>
                    <p className="mt-0.5 text-xs text-[#8994a1]">Log in to Instagram in the browser window,<br />then come back here — we'll detect it automatically.</p>
                  </div>
                </div>
              ) : (
                <button
                  onClick={handleBrowserConnect}
                  disabled={loading}
                  className="flex items-center justify-center gap-2 rounded-xl bg-[#17202b] py-2.5 text-sm font-semibold text-white transition hover:bg-[#2b3948] disabled:opacity-60"
                >
                  <Globe className="size-4" />
                  Connect Instagram via Browser
                </button>
              )}
              <p className="text-center text-xs text-[#8994a1]">
                A Chrome window will open. Log in to Instagram normally — your password is never seen or stored by us.
              </p>
              {error && (
                <p className="rounded-lg border border-[#f5c6c6] bg-[#fff5f5] px-3 py-2 text-xs text-[#9b2c2c]">
                  {error}
                </p>
              )}
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
