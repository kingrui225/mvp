'use client'

import {
  AtSign,
  Clock,
  Film,
  Hash,
  Heart,
  Images,
  LogOut,
  MapPin,
  MessageCircle,
  Play,
  Search,
  Settings,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ConnectedAccountsModal, type InstagramStatus } from '@/components/connected-accounts-modal'

// ─── Types ────────────────────────────────────────────────────────────────────

type SearchType = 'top' | 'reel' | 'hashtag' | 'place'

interface PostResult {
  pk?: string
  code?: string
  url?: string
  media_type?: 'photo' | 'video' | 'carousel' | 'place'
  thumbnail_url?: string
  video_url?: string
  caption?: string
  like_count?: number
  comment_count?: number
  view_count?: number
  taken_at?: string
  username?: string
  user_pk?: string
  is_verified?: boolean
}

interface SearchRecord {
  id: string
  timestamp: string
  query: string
  search_type: SearchType
  limit: number
  results: PostResult[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

const SEARCH_TYPES: { value: SearchType; label: string; icon: typeof Search }[] = [
  { value: 'top', label: 'Top Posts', icon: Sparkles },
  { value: 'reel', label: 'Reels', icon: Film },
  { value: 'hashtag', label: 'Hashtag', icon: Hash },
  { value: 'place', label: 'Places', icon: MapPin },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
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

function truncateCaption(text: string, max = 100): string {
  if (!text) return ''
  return text.length > max ? text.slice(0, max).trimEnd() + '…' : text
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function MediaTypeBadge({ type }: { type?: string }) {
  if (!type || type === 'photo') return null
  const map: Record<string, { label: string; Icon: typeof Play }> = {
    video:    { label: 'Reel', Icon: Play },
    carousel: { label: 'Album', Icon: Images },
    place:    { label: 'Place', Icon: MapPin },
  }
  const entry = map[type]
  if (!entry) return null
  const { label, Icon } = entry
  return (
    <span className="flex items-center gap-1 rounded-md bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
      <Icon className="size-2.5" />
      {label}
    </span>
  )
}

function PostCard({ post }: { post: PostResult }) {
  const [imgError, setImgError] = useState(false)
  const href = post.url ?? (post.code ? `https://www.instagram.com/p/${post.code}/` : '#')

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col overflow-hidden rounded-2xl border border-[#e8eaed] bg-white transition hover:-translate-y-0.5 hover:border-[#c8cdd3] hover:shadow-[0_4px_16px_rgba(23,32,43,0.10)]"
    >
      {/* Thumbnail */}
      <div className="relative aspect-square w-full overflow-hidden bg-[#f0f2f5]">
        {post.thumbnail_url && !imgError ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={post.thumbnail_url}
            alt={post.caption ?? ''}
            onError={() => setImgError(true)}
            className="size-full object-cover transition group-hover:scale-[1.02]"
          />
        ) : (
          <div className="flex size-full items-center justify-center text-[#c8cdd3]">
            <Sparkles className="size-8" />
          </div>
        )}
        {/* Media type badge */}
        <div className="absolute right-2 top-2">
          <MediaTypeBadge type={post.media_type} />
        </div>
        {/* Reel play icon overlay */}
        {post.media_type === 'video' && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
            <div className="flex size-10 items-center justify-center rounded-full bg-black/40 backdrop-blur-sm">
              <Play className="size-5 fill-white text-white" />
            </div>
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="flex flex-col gap-2 p-3">
        {/* Stats row */}
        <div className="flex items-center gap-3 text-xs text-[#7a8593]">
          {post.like_count != null && (
            <span className="flex items-center gap-1">
              <Heart className="size-3.5" />
              {formatCount(post.like_count)}
            </span>
          )}
          {post.comment_count != null && (
            <span className="flex items-center gap-1">
              <MessageCircle className="size-3.5" />
              {formatCount(post.comment_count)}
            </span>
          )}
          {post.view_count != null && (
            <span className="flex items-center gap-1">
              <Play className="size-3.5" />
              {formatCount(post.view_count)}
            </span>
          )}
          {post.taken_at && (
            <span className="ml-auto shrink-0">{timeAgo(post.taken_at)}</span>
          )}
        </div>

        {/* Username */}
        {post.username && (
          <p className="truncate text-[11px] font-semibold text-[#273442]">
            @{post.username}
          </p>
        )}

        {/* Caption */}
        {post.caption && (
          <p className="text-[11px] leading-4 text-[#657180]">
            {truncateCaption(post.caption)}
          </p>
        )}
      </div>
    </a>
  )
}

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[#f5c6c6] bg-[#fff5f5] px-4 py-3 text-sm text-[#9b2c2c]">
      <span className="flex-1 font-mono text-xs">{message}</span>
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
  const [limit, setLimit] = useState(100)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<SearchRecord | null>(null)
  const [history, setHistory] = useState<SearchRecord[]>([])
  const [igAccount, setIgAccount] = useState<InstagramStatus | null>(null)
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const supabase = createClient()

  // ── Load history + Instagram status on mount ──────────────────────────────
  useEffect(() => {
    fetch('/api/history')
      .then((r) => r.json())
      .then((data: SearchRecord[]) => {
        setHistory(data)
        if (data.length > 0) setActiveRecord(data[0])
      })
      .catch(() => {})

    fetch('/api/instagram/status')
      .then((r) => r.json())
      .then((data: InstagramStatus) => setIgAccount(data))
      .catch(() => {})
  }, [])

  // ── Supabase sign out ─────────────────────────────────────────────────────
  async function handleSignOut() {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  // ── Search ────────────────────────────────────────────────────────────────
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
          body: JSON.stringify({ query: q, search_type: searchType, limit }),
        })
        const data = await res.json()
        if (!res.ok) {
          setError(data.error ?? 'Search failed.')
        } else {
          const record = data as SearchRecord
          setActiveRecord(record)
          setHistory((prev) => [record, ...prev.filter((r) => r.id !== record.id)])
          // Refresh IG account status in case this was the first linked search.
          fetch('/api/instagram/status')
            .then((r) => r.json())
            .then((a: InstagramStatus) => setIgAccount(a))
            .catch(() => {})
        }
      } catch {
        setError('Network error — could not reach the server.')
      } finally {
        setLoading(false)
      }
    },
    [query, searchType, limit, loading],
  )

  // ── Hide / soft-delete a history record ───────────────────────────────────
  async function hideRecord(id: string) {
    await fetch(`/api/history?id=${id}`, { method: 'DELETE' })
    setHistory((prev) => {
      const next = prev.filter((r) => r.id !== id)
      if (activeRecord?.id === id) setActiveRecord(next[0] ?? null)
      return next
    })
  }

  const posts = activeRecord?.results ?? []

  return (
    <div className="flex h-screen overflow-hidden bg-[#f5f6f8] text-[#17202b]">
      {/* ── Sidebar ─────────────────────────────────────────────────── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-[#e1e5ea] bg-white">
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

        <div className="flex-1 overflow-y-auto">
          {history.length === 0 ? (
            <p className="px-5 py-3 text-xs text-[#a3acb7]">No searches yet.</p>
          ) : (
            history.map((record) => {
              const TypeIcon = SEARCH_TYPES.find((t) => t.value === record.search_type)?.icon ?? Sparkles
              return (
                <div
                  key={record.id}
                  onClick={() => setActiveRecord(record)}
                  className={`group flex cursor-pointer items-start gap-2.5 px-4 py-3 transition ${
                    activeRecord?.id === record.id ? 'bg-[#f0f2f5]' : 'hover:bg-[#f7f8fa]'
                  }`}
                >
                  <TypeIcon className="mt-0.5 size-3.5 shrink-0 text-[#8994a1]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[#273442]">{record.query}</p>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[#a3acb7]">
                      <Clock className="size-3" />
                      <span>{timeAgo(record.timestamp)}</span>
                      <span>·</span>
                      <span>{record.results.length} posts</span>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); hideRecord(record.id) }}
                    className="shrink-0 text-transparent transition group-hover:text-[#b0b8c1] hover:!text-[#657180]"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              )
            })
          )}
        </div>

        {/* ── Sidebar footer ─────────────────────────────────────────── */}
        <div className="border-t border-[#edf0f3]">
          {/* Instagram account button — opens Connected Accounts modal */}
          <button
            onClick={() => setAccountModalOpen(true)}
            className="flex w-full items-center gap-2.5 px-4 py-3 transition hover:bg-[#f7f8fa]"
          >
            {igAccount === null ? (
              // Loading skeleton
              <>
                <div className="size-7 animate-pulse rounded-full bg-[#edf0f3]" />
                <div className="h-3 w-24 animate-pulse rounded bg-[#edf0f3]" />
              </>
            ) : igAccount.connected ? (
              // Connected state
              <>
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#f9ce34] via-[#ee2a7b] to-[#6228d7]">
                  <AtSign className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="truncate text-xs font-semibold text-[#273442]">
                    @{igAccount.username ?? igAccount.user_id ?? 'Instagram'}
                  </p>
                  <p className="text-[10px] text-[#a3acb7]">Tap to manage</p>
                </div>
                <Settings className="size-3.5 shrink-0 text-[#b0b8c1]" />
              </>
            ) : (
              // Disconnected state
              <>
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#f0f2f5]">
                  <AtSign className="size-3.5 text-[#a3acb7]" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-xs font-semibold text-[#8994a1]">Connect Instagram</p>
                  <p className="text-[10px] text-[#a3acb7]">Tap to link an account</p>
                </div>
              </>
            )}
          </button>

          {/* App sign-out button — signs out of the page account (Supabase) */}
          <div className="border-t border-[#edf0f3]">
            <button
              onClick={handleSignOut}
              className="flex w-full items-center gap-2 px-4 py-3 text-xs text-[#8994a1] transition hover:bg-[#f7f8fa] hover:text-[#273442]"
            >
              <LogOut className="size-3.5" />
              Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ────────────────────────────────────────────────────── */}
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
              placeholder={
                searchType === 'hashtag' ? 'Search by hashtag…' :
                searchType === 'place'   ? 'Search by location…' :
                searchType === 'reel'    ? 'Search reels…' :
                'Search posts…'
              }
              className="w-full rounded-xl border border-[#d9dfe6] bg-[#f8f9fb] py-2.5 pl-9 pr-4 text-sm text-[#17202b] outline-none transition placeholder:text-[#8994a1] focus:border-[#17202b] focus:bg-white focus:ring-2 focus:ring-[#17202b]/10"
            />
          </div>

          {/* Limit picker */}
          <div className="flex shrink-0 items-center gap-1.5">
            <label htmlFor="limit-select" className="text-xs font-medium text-[#8994a1] whitespace-nowrap">
              Top
            </label>
            <select
              id="limit-select"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="cursor-pointer appearance-none rounded-lg border border-[#d9dfe6] bg-[#f8f9fb] py-2 pl-2.5 pr-6 text-xs font-semibold text-[#273442] outline-none transition focus:border-[#17202b] focus:ring-2 focus:ring-[#17202b]/10"
            >
              {[10, 25, 50, 100, 200, 500].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
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

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {error && (
            <div className="mb-4">
              <ErrorBanner message={error} onDismiss={() => setError(null)} />
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center gap-3 py-24 text-center">
              <div className="relative flex size-14 items-center justify-center rounded-full bg-[#eef1f5]">
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-[#17202b]" />
                <Sparkles className="size-6 text-[#17202b]" />
              </div>
              <p className="text-sm font-medium text-[#657180]">Searching Instagram…</p>
              <p className="text-xs text-[#a3acb7]">This may take a moment.</p>
            </div>
          )}

          {/* Results grid */}
          {!loading && activeRecord && (
            <>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold tracking-tight">
                    &ldquo;{activeRecord.query}&rdquo;
                  </h2>
                  <p className="mt-0.5 text-xs text-[#7a8593]">
                    {posts.length} of {activeRecord.limit} requested ·{' '}
                    {activeRecord.search_type} ·{' '}
                    {timeAgo(activeRecord.timestamp)}
                  </p>
                </div>
              </div>

              {posts.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#d9dfe6] bg-white px-6 py-16 text-center">
                  <Search className="mx-auto mb-3 size-8 text-[#c8cdd3]" />
                  <p className="text-sm font-medium text-[#657180]">No posts found.</p>
                  <p className="mt-1 text-xs text-[#a3acb7]">Try a different query or search type.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {posts.map((post, i) => (
                    <PostCard key={`${activeRecord.id}-${i}`} post={post} />
                  ))}
                </div>
              )}
            </>
          )}

          {/* Empty state */}
          {!loading && !activeRecord && !error && (
            <div className="flex flex-col items-center gap-3 py-28 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-[#eef1f5]">
                <Search className="size-7 text-[#c8cdd3]" />
              </div>
              <p className="text-sm font-medium text-[#657180]">
                Search for posts, reels, or carousels.
              </p>
              {!igAccount?.connected && (
                <button
                  onClick={() => setAccountModalOpen(true)}
                  className="mt-1 rounded-lg bg-[#17202b] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2b3948]"
                >
                  Connect Instagram to start searching
                </button>
              )}
            </div>
          )}
        </div>
      </main>

      {/* ── Connected Accounts Modal ─────────────────────────────────── */}
      <ConnectedAccountsModal
        open={accountModalOpen}
        onClose={() => setAccountModalOpen(false)}
        account={igAccount}
        onChanged={(next) => setIgAccount(next)}
      />
    </div>
  )
}
