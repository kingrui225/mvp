'use client'

import {
  CheckCircle,
  Clock,
  Hash,
  Lock,
  MapPin,
  Search,
  Sparkles,
  Trash2,
  User,
  Users,
  X,
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchType = 'top' | 'user' | 'hashtag' | 'place'

interface SearchResult {
  pk?: string
  username?: string
  name?: string
  tag_name?: string
  full_name?: string
  is_private?: boolean
  is_verified?: boolean
  profile_pic_url?: string
  follower_count?: number
}

interface SearchRecord {
  id: string
  timestamp: string
  query: string
  search_type: SearchType
  results: SearchResult[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_TYPES: { value: SearchType; label: string; icon: typeof Search }[] = [
  { value: 'top', label: 'Top', icon: Sparkles },
  { value: 'user', label: 'Users', icon: User },
  { value: 'hashtag', label: 'Tags', icon: Hash },
  { value: 'place', label: 'Places', icon: MapPin },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function displayName(r: SearchResult): string {
  return r.username ?? r.tag_name ?? r.name ?? r.pk ?? '—'
}

function subline(r: SearchResult): string {
  const parts: string[] = []
  if (r.full_name && r.full_name !== displayName(r)) parts.push(r.full_name)
  if (r.follower_count != null)
    parts.push(`${formatCount(r.follower_count)} followers`)
  return parts.join(' · ')
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function initials(r: SearchResult): string {
  const label = displayName(r)
  return label.replace('@', '').slice(0, 2).toUpperCase()
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function Avatar({ result }: { result: SearchResult }) {
  const [imgError, setImgError] = useState(false)
  if (result.profile_pic_url && !imgError) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={result.profile_pic_url}
        alt=""
        onError={() => setImgError(true)}
        className="size-10 rounded-full object-cover"
      />
    )
  }
  return (
    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#17202b] text-[11px] font-bold text-white">
      {initials(result)}
    </div>
  )
}

function ResultCard({ result }: { result: SearchResult }) {
  const label = displayName(result)
  const sub = subline(result)

  return (
    <div className="flex items-center gap-3 rounded-xl border border-[#e8eaed] bg-white px-4 py-3 transition hover:border-[#c8cdd3] hover:shadow-[0_2px_8px_rgba(23,32,43,0.07)]">
      <Avatar result={result} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate">
          <span className="truncate text-sm font-semibold text-[#17202b]">
            {result.username ? `@${result.username}` : result.tag_name ? `#${result.tag_name}` : label}
          </span>
          {result.is_verified && (
            <CheckCircle aria-label="Verified" className="size-3.5 shrink-0 text-[#3897f0]" />
          )}
          {result.is_private && (
            <Lock aria-label="Private" className="size-3.5 shrink-0 text-[#8994a1]" />
          )}
        </div>
        {sub && (
          <p className="mt-0.5 truncate text-xs text-[#7a8593]">{sub}</p>
        )}
      </div>
      {result.follower_count != null && (
        <div className="flex shrink-0 items-center gap-1 text-xs text-[#8994a1]">
          <Users className="size-3.5" />
          <span>{formatCount(result.follower_count)}</span>
        </div>
      )}
    </div>
  )
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#f5c6c6] bg-[#fff5f5] px-4 py-3 text-sm text-[#9b2c2c]">
      <span className="flex-1">{message}</span>
      <button onClick={onDismiss} className="shrink-0 text-[#9b2c2c]/60 hover:text-[#9b2c2c]">
        <X className="size-4" />
      </button>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const [searchType, setSearchType] = useState<SearchType>('top')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<SearchRecord | null>(null)
  const [history, setHistory] = useState<SearchRecord[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Load history on mount
  useEffect(() => {
    fetch('/api/history')
      .then((r) => r.json())
      .then((data: SearchRecord[]) => {
        setHistory(data)
        if (data.length > 0) setActiveRecord(data[0])
      })
      .catch(() => {})
  }, [])

  const runSearch = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const q = query.trim()
      if (!q || loading) return

      setLoading(true)
      setError(null)

      try {
        const res = await fetch('/api/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q, search_type: searchType }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error ?? 'Search failed.')
        } else {
          const record = data as SearchRecord
          setActiveRecord(record)
          setHistory((prev) => [record, ...prev.filter((r) => r.id !== record.id)])
        }
      } catch {
        setError('Network error — could not reach the server.')
      } finally {
        setLoading(false)
      }
    },
    [query, searchType, loading],
  )

  async function deleteRecord(id: string) {
    await fetch(`/api/history?id=${id}`, { method: 'DELETE' })
    setHistory((prev) => {
      const next = prev.filter((r) => r.id !== id)
      if (activeRecord?.id === id) setActiveRecord(next[0] ?? null)
      return next
    })
  }

  const results = activeRecord?.results ?? []

  return (
    <div className="flex h-screen overflow-hidden bg-[#f5f6f8] text-[#17202b]">
      {/* ── Sidebar ───────────────────────────────────────── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-[#e1e5ea] bg-white">
        {/* Logo */}
        <div className="flex items-center gap-2.5 border-b border-[#edf0f3] px-5 py-4">
          <div className="flex size-7 items-center justify-center rounded-lg bg-[#17202b] text-white">
            <Sparkles className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-tight">Agenticfruit</span>
        </div>

        {/* History label */}
        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-[#a3acb7]">
            History
          </span>
          {history.length > 0 && (
            <button
              onClick={async () => {
                await fetch('/api/history', { method: 'DELETE' })
                setHistory([])
                setActiveRecord(null)
              }}
              title="Clear all history"
              className="text-[#b0b8c1] transition hover:text-[#657180]"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <p className="px-5 py-3 text-xs text-[#a3acb7]">No searches yet.</p>
          ) : (
            history.map((record) => (
              <div
                key={record.id}
                onClick={() => setActiveRecord(record)}
                className={`group flex cursor-pointer items-start gap-2.5 px-4 py-3 transition ${
                  activeRecord?.id === record.id
                    ? 'bg-[#f0f2f5]'
                    : 'hover:bg-[#f7f8fa]'
                }`}
              >
                <div className="mt-0.5 shrink-0 text-[#8994a1]">
                  {record.search_type === 'user' && <User className="size-3.5" />}
                  {record.search_type === 'hashtag' && <Hash className="size-3.5" />}
                  {record.search_type === 'place' && <MapPin className="size-3.5" />}
                  {record.search_type === 'top' && <Sparkles className="size-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-[#273442]">{record.query}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[#a3acb7]">
                    <Clock className="size-3" />
                    <span>{timeAgo(record.timestamp)}</span>
                    <span>·</span>
                    <span>{record.results.length} results</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); deleteRecord(record.id) }}
                  className="shrink-0 text-transparent transition group-hover:text-[#b0b8c1] hover:!text-[#657180]"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* Search bar */}
        <form
          onSubmit={runSearch}
          className="flex items-center gap-3 border-b border-[#e1e5ea] bg-white px-6 py-4"
        >
          {/* Type pills */}
          <div className="flex gap-1">
            {SEARCH_TYPES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => setSearchType(value)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-1 ${
                  searchType === value
                    ? 'bg-[#17202b] text-white'
                    : 'bg-[#f0f2f5] text-[#657180] hover:bg-[#e5e8ec] hover:text-[#17202b]'
                }`}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Query input */}
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#8c97a4]" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search Instagram…"
              className="w-full rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] py-2.5 pl-9 pr-4 text-sm text-[#17202b] outline-none transition placeholder:text-[#8994a1] focus:border-[#17202b] focus:bg-white focus:ring-2 focus:ring-[#17202b]/10"
            />
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !query.trim()}
            className="flex items-center gap-2 rounded-xl bg-[#17202b] px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2b3948] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-1"
          >
            {loading ? (
              <>
                <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Searching
              </>
            ) : (
              <>
                <Search className="size-4" />
                Search
              </>
            )}
          </button>
        </form>

        {/* Results area */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {error && (
            <div className="mb-4">
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <div className="relative flex size-14 items-center justify-center rounded-full bg-[#eef1f5]">
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#17202b]" />
                <Sparkles className="size-6 text-[#17202b]" />
              </div>
              <p className="text-sm font-medium text-[#657180]">Searching Instagram…</p>
              <p className="text-xs text-[#a3acb7]">This may take a moment on first run.</p>
            </div>
          )}

          {/* Results */}
          {!loading && activeRecord && (
            <>
              {/* Header */}
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-[#17202b]">
                    &ldquo;{activeRecord.query}&rdquo;
                  </h2>
                  <p className="mt-0.5 text-xs text-[#7a8593]">
                    {results.length} result{results.length !== 1 ? 's' : ''} ·{' '}
                    {activeRecord.search_type} search ·{' '}
                    {timeAgo(activeRecord.timestamp)}
                  </p>
                </div>
              </div>

              {results.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#d9dfe6] bg-white px-6 py-16 text-center">
                  <Search className="mx-auto mb-3 size-8 text-[#c8cdd3]" />
                  <p className="text-sm font-medium text-[#657180]">No results found.</p>
                  <p className="mt-1 text-xs text-[#a3acb7]">Try a different query or search type.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {results.map((r, i) => (
                    <ResultCard key={r.pk ?? i} result={r} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Empty state — no search run yet */}
          {!loading && !activeRecord && !error && (
            <div className="flex flex-col items-center gap-3 py-28 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-[#eef1f5]">
                <Search className="size-7 text-[#c8cdd3]" />
              </div>
              <p className="text-sm font-medium text-[#657180]">
                Enter a query above to search Instagram.
              </p>
              <p className="text-xs text-[#a3acb7]">
                On first run, a browser window will open so you can log in.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
