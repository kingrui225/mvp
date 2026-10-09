'use client'

import { createClient } from '@/lib/supabase/client'
import { Sparkles } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { FormEvent, useState } from 'react'

type Mode = 'signin' | 'signup' | 'reset'

export default function LoginPage() {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMessage(null)
    // createClient() called here so it only runs in the browser, never during SSR
    const supabase = createClient()

    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        router.replace('/search')
        router.refresh()
      } else if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${location.origin}/auth/callback` },
        })
        if (error) throw error
        setMessage('Check your email for a confirmation link.')
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${location.origin}/auth/callback?next=/search`,
        })
        if (error) throw error
        setMessage('Password reset link sent — check your email.')
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#f5f6f8] px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[#17202b] text-white">
            <Sparkles className="size-5" />
          </div>
          <div className="text-center">
            <h1 className="text-lg font-semibold tracking-tight text-[#17202b]">Agenticfruit</h1>
            <p className="mt-0.5 text-sm text-[#8994a1]">
              {mode === 'signin' && 'Sign in to your account'}
              {mode === 'signup' && 'Create your account'}
              {mode === 'reset' && 'Reset your password'}
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-[#e1e5ea] bg-white px-8 py-8 shadow-sm">
          <form onSubmit={handleSubmit} autoComplete="off" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="email" className="text-xs font-semibold text-[#273442]">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="off"
                readOnly
                onFocus={(e) => e.currentTarget.removeAttribute('readonly')}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm text-[#17202b] outline-none placeholder:text-[#8994a1] focus:border-[#17202b] focus:bg-white focus:ring-2 focus:ring-[#17202b]/10"
                placeholder="you@example.com"
              />
            </div>

            {mode !== 'reset' && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor="password" className="text-xs font-semibold text-[#273442]">
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="off"
                  readOnly
                  onFocus={(e) => e.currentTarget.removeAttribute('readonly')}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] px-3.5 py-2.5 text-sm text-[#17202b] outline-none placeholder:text-[#8994a1] focus:border-[#17202b] focus:bg-white focus:ring-2 focus:ring-[#17202b]/10"
                  placeholder={mode === 'signup' ? 'Min. 8 characters' : '••••••••'}
                />
              </div>
            )}

            {error && (
              <p className="rounded-lg bg-[#fff5f5] px-3 py-2 text-xs text-[#9b2c2c] border border-[#f5c6c6]">
                {error}
              </p>
            )}
            {message && (
              <p className="rounded-lg bg-[#f0fff4] px-3 py-2 text-xs text-[#276749] border border-[#c6f6d5]">
                {message}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-[#17202b] py-2.5 text-sm font-semibold text-white transition hover:bg-[#2b3948] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? (
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <>
                  {mode === 'signin' && 'Sign in'}
                  {mode === 'signup' && 'Create account'}
                  {mode === 'reset' && 'Send reset link'}
                </>
              )}
            </button>
          </form>

          {/* Mode toggles */}
          <div className="mt-5 flex flex-col items-center gap-2">
            {mode === 'signin' && (
              <>
                <button
                  onClick={() => { setMode('signup'); setError(null); setMessage(null) }}
                  className="text-xs text-[#657180] hover:text-[#17202b]"
                >
                  Don&apos;t have an account? <span className="font-semibold">Sign up</span>
                </button>
                <button
                  onClick={() => { setMode('reset'); setError(null); setMessage(null) }}
                  className="text-xs text-[#a3acb7] hover:text-[#657180]"
                >
                  Forgot password?
                </button>
              </>
            )}
            {(mode === 'signup' || mode === 'reset') && (
              <button
                onClick={() => { setMode('signin'); setError(null); setMessage(null) }}
                className="text-xs text-[#657180] hover:text-[#17202b]"
              >
                Already have an account? <span className="font-semibold">Sign in</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
