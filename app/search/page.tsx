'use client'

import {
  AtSign,
  ChevronDown,
  ChevronUp,
  Clock,
  CreditCard,
  Download,
  FileText,
  Film,
  Hash,
  Info,
  Heart,
  Images,
  LogOut,
  MapPin,
  MessageCircle,
  Mic,
  Play,
  Search,
  Settings,
  Sparkles,
  Star,
  Trash2,
  Volume2,
  X,
  Zap,
} from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ConnectedAccountsModal, type InstagramStatus } from '@/components/connected-accounts-modal'
import {
  OFF_BRAND_FIT,
  SORT_LABELS,
  countBy,
  engagementRate,
  extractHashtags,
  fitTone,
  humanLabel,
  sortPosts,
  topAlternatives,
  withinDays,
  type SortKey,
} from '@/lib/post-metrics'
import { rankScore, type PostScore } from '@/lib/jev'
import { BRAND_BRIEF } from '@/lib/brand-brief'

// ─── Types ────────────────────────────────────────────────────────────────────

interface BillingStatus {
  active: boolean
  status: string | null
  current_period_end: string | null
  has_customer: boolean
}

type SearchType = 'top' | 'reel' | 'hashtag' | 'place'

interface TranscriptResult {
  text: string
  language?: string
  duration_seconds?: number
  word_count?: number
  model?: string
  audio_storage_path?: string
  transcript_storage_path?: string
  segments?: Array<{ start: number; end: number; text: string }>
  error?: string
}

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
  transcript?: TranscriptResult
}

interface ScoreUsage { calls: number; cached: number; inputTokens: number; usd: number; ms: number }

type ScoreStatus =
  | { state: 'idle' }
  | { state: 'loading'; n: number }
  | { state: 'done'; n: number; usage: ScoreUsage }
  | { state: 'error'; message: string }

interface SearchRecord {
  id: string
  timestamp: string
  query: string
  search_type: SearchType
  limit: number
  results: PostResult[]
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Set NEXT_PUBLIC_BILLING_GATE_ENABLED=true in env to show the upgrade wall.
const BILLING_GATE_ENABLED = process.env.NEXT_PUBLIC_BILLING_GATE_ENABLED === 'true'

const SEARCH_TYPES: { value: SearchType; label: string; icon: typeof Search }[] = [
  { value: 'top', label: 'Top Posts', icon: Sparkles },
  { value: 'reel', label: 'Reels', icon: Film },
  { value: 'hashtag', label: 'Hashtag', icon: Hash },
  { value: 'place', label: 'Places', icon: MapPin },
]

const FIT_TONE = {
  high: 'bg-[#e3f4e8] text-[#1e7a3c]',
  mid: 'bg-[#fdf1d8] text-[#9a6200]',
  low: 'bg-[#eef1f5] text-[#8994a1]',
}

const RECENCY_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Any time' },
  { value: 1, label: '24h' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
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

function codeScored(posts: PostResult[], scores: Record<string, PostScore>) {
  return posts.some((p) => p.code && scores[p.code])
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

/** Fetches a short-lived signed URL for a Supabase Storage artifact. */
async function fetchSignedUrl(storagePath: string): Promise<string> {
  const res = await fetch(
    `/api/transcripts/signed-url?path=${encodeURIComponent(storagePath)}&expires=3600`,
  )
  if (!res.ok) throw new Error('Could not generate download URL')
  const d = await res.json()
  return d.url as string
}

function TranscriptPanel({ transcript, postCode }: { transcript: TranscriptResult; postCode?: string }) {
  const [expanded, setExpanded] = useState(false)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioLoading, setAudioLoading] = useState(false)

  const hasText = Boolean(transcript.text?.trim())
  const hasAudio = Boolean(transcript.audio_storage_path)

  async function handleAudioDownload() {
    if (audioUrl || !transcript.audio_storage_path) return
    setAudioLoading(true)
    try {
      const url = await fetchSignedUrl(transcript.audio_storage_path)
      setAudioUrl(url)
      // Open in new tab
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      // ignore — user can retry
    } finally {
      setAudioLoading(false)
    }
  }

  if (!hasText && !hasAudio) return null

  return (
    <div className="border-t border-[#f0f2f5]">
      {/* Toggle button */}
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((v) => !v) }}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[10px] font-semibold text-[#5a6675] transition hover:bg-[#f7f8fa]"
      >
        <Mic className="size-3 shrink-0 text-[#8b97a5]" />
        <span className="flex-1">
          Transcript
          {transcript.word_count ? ` · ${transcript.word_count} words` : ''}
          {transcript.language ? ` · ${transcript.language.toUpperCase()}` : ''}
        </span>
        {expanded ? <ChevronUp className="size-3 text-[#a3acb7]" /> : <ChevronDown className="size-3 text-[#a3acb7]" />}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3">
          {hasText && (
            <p className="mb-2 max-h-40 overflow-y-auto rounded-lg bg-[#f5f6f8] p-2.5 text-[10px] leading-[1.65] text-[#475260]">
              {transcript.text}
            </p>
          )}

          {/* Action buttons */}
          <div className="flex items-center gap-2">
            {hasAudio && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); void handleAudioDownload() }}
                disabled={audioLoading}
                className="flex items-center gap-1 rounded-md bg-[#17202b] px-2.5 py-1.5 text-[10px] font-semibold text-white transition hover:bg-[#2b3948] disabled:opacity-60"
              >
                {audioLoading
                  ? <span className="size-2.5 animate-spin rounded-full border border-white/30 border-t-white" />
                  : <Volume2 className="size-2.5" />}
                Download MP3
              </button>
            )}
            {transcript.transcript_storage_path && (
              <button
                onClick={async (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  try {
                    const url = await fetchSignedUrl(transcript.transcript_storage_path!)
                    window.open(url, '_blank', 'noopener,noreferrer')
                  } catch { /* ignore */ }
                }}
                className="flex items-center gap-1 rounded-md border border-[#e1e5ea] px-2.5 py-1.5 text-[10px] font-semibold text-[#5a6675] transition hover:bg-[#f0f2f5]"
              >
                <FileText className="size-2.5" />
                JSON
              </button>
            )}
            {transcript.duration_seconds != null && (
              <span className="ml-auto text-[10px] text-[#a3acb7]">
                {Math.floor(transcript.duration_seconds / 60)}:{String(Math.round(transcript.duration_seconds % 60)).padStart(2, '0')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const pct = (n: number) => `${Math.round(n * 100)}%`

function Bar({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-[#5a6675]">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#e5e8ec]">
        <div className="h-full rounded-full bg-[#17202b]" style={{ width: pct(Math.min(1, Math.max(0, value))) }} />
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums text-[#17202b]">{sub ?? pct(value)}</span>
    </div>
  )
}

function Pick({ title, id, confidence, answer }: { title: string; id: string; confidence: number; answer: unknown }) {
  const alts = topAlternatives(answer).filter(([k]) => k !== id).slice(0, 2)
  return (
    <div className="space-y-1">
      <p className="text-[#17202b]">
        <span className="text-[#8994a1]">{title}: </span>
        <b>{humanLabel(id)}</b> · {pct(confidence)} confident
      </p>
      {alts.map(([k, v]) => <Bar key={k} label={humanLabel(k)} value={v} />)}
    </div>
  )
}

function WhyPanel({ post, score, error }: { post: PostResult; score?: PostScore; error?: string }) {
  const rank = score ? rankScore(score.fit, post) : null
  const eng = engagementRate(post)
  const fb = score?.fitBreakdown
  const rawBrand = score?.answers?.brand_fit?.score
  return (
    <div className="space-y-3 border-t border-[#f0f2f5] bg-[#fafbfc] px-3 py-3 text-[10px] leading-4">
      {error && <p className="rounded-md bg-[#fff5f5] px-2 py-1.5 text-[#9b2c2c]">Scoring failed: {error}</p>}
      {!score && !error && <p className="text-[#8994a1]">Not scored yet.</p>}
      {score && rank && fb && (
        <>
          <section className="space-y-1.5">
            <p className="font-semibold uppercase tracking-wide text-[#8994a1]">Rank = {rank.score.toFixed(2)}</p>
            <div className="grid grid-cols-3 gap-1.5 text-center">
              <div className="rounded-md bg-white p-1.5 ring-1 ring-[#e8eaed]">
                <p className="text-sm font-semibold tabular-nums">{score.fit.toFixed(2)}</p>
                <p className="text-[#8994a1]">brand fit</p>
              </div>
              <div className="rounded-md bg-white p-1.5 ring-1 ring-[#e8eaed]">
                <p className="text-sm font-semibold tabular-nums">×{(0.5 + 0.5 * rank.recency).toFixed(2)}</p>
                <p className="text-[#8994a1]">recency {rank.recency.toFixed(2)}{post.taken_at ? '' : ' (unknown)'}</p>
              </div>
              <div className="rounded-md bg-white p-1.5 ring-1 ring-[#e8eaed]">
                <p className="text-sm font-semibold tabular-nums">×{(0.5 + 0.5 * rank.engNorm).toFixed(2)}</p>
                <p className="text-[#8994a1]">engagement {eng == null ? '(unknown)' : `${(eng * 100).toFixed(1)}%`}</p>
              </div>
            </div>
            <p className="text-[#8994a1]">
              rank = fit × (0.5 + 0.5·recency) × (0.5 + 0.5·engagement). Recency decays e<sup>−age/30d</sup>; engagement = (likes+comments)/views, capped at 10%; unknown counts as 0.5.
            </p>
          </section>
          <section className="space-y-1">
            <p className="font-semibold uppercase tracking-wide text-[#8994a1]">Fit = {pct(score.fit)}</p>
            <Bar label="Brand fit" value={fb.brandFit} sub={rawBrand != null ? `${rawBrand}/3 · ${pct(fb.brandFit)}` : pct(fb.brandFit)} />
            <Bar label="Audience fit" value={fb.audienceFit} />
            <Bar label="Junk / off-topic" value={fb.junkPenalty} />
            <Bar label="Sponsored" value={score.sponsored} sub={`${pct(score.sponsored)} (info)`} />
            <p className="text-[#8994a1]">fit = brand/3 × (0.5 + 0.5·audience) × (1 − junk). Sponsored is shown, not used in rank.</p>
          </section>
          <section className="space-y-2">
            <Pick title="Topic" id={score.topic} confidence={score.topicConfidence} answer={score.answers?.topic} />
            <Pick title="Format" id={score.format} confidence={score.formatConfidence} answer={score.answers?.format} />
            <Pick title="Hook" id={score.hook} confidence={score.hookConfidence} answer={score.answers?.hook} />
          </section>
        </>
      )}
    </div>
  )
}

function PostCard({ post, score, error, onTag }: { post: PostResult; score?: PostScore; error?: string; onTag: (tag: string) => void }) {
  const [why, setWhy] = useState(false)
  const [imgError, setImgError] = useState(false)
  const href = post.url ?? (post.code ? `https://www.instagram.com/p/${post.code}/` : '#')
  const hasTranscript = Boolean(post.transcript?.text?.trim() || post.transcript?.audio_storage_path)
  const eng = engagementRate(post)
  const tags = extractHashtags(post.caption).slice(0, 5)

  return (
    <div className="group flex flex-col overflow-hidden rounded-2xl border border-[#e8eaed] bg-white transition hover:-translate-y-0.5 hover:border-[#c8cdd3] hover:shadow-[0_4px_16px_rgba(23,32,43,0.10)]">
      {/* Main clickable area → opens Instagram */}
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex flex-col"
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
          <div className="absolute right-2 top-2 flex items-center gap-1">
            {hasTranscript && (
              <span className="flex items-center gap-0.5 rounded-md bg-[#17202b]/80 px-1.5 py-0.5 text-[9px] font-semibold text-white backdrop-blur-sm">
                <Mic className="size-2" />
                Transcript
              </span>
            )}
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

          {eng != null && (
            <span
              title="(likes + comments) / views"
              className="w-fit rounded-md bg-[#eef1f5] px-1.5 py-0.5 text-[10px] font-semibold text-[#475260]"
            >
              {(eng * 100).toFixed(1)}% eng
            </span>
          )}

          {score && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${FIT_TONE[fitTone(score.fit)]}`}>
                Fit {pct(score.fit)}
              </span>
              <span className="text-[10px] text-[#8994a1]">
                {humanLabel(score.topic ?? 'other')} · {humanLabel(score.format ?? 'other')}
              </span>
            </div>
          )}

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

      {/* Hashtag chips — outside the <a> so clicks filter instead of navigating */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-3">
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => onTag(t)}
              className="rounded-md bg-[#f0f2f5] px-1.5 py-0.5 text-[10px] font-medium text-[#5a6675] transition hover:bg-[#e5e8ec] hover:text-[#17202b]"
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {/* Why? — outside the <a> so clicks don't navigate */}
      {(score || error) && (
        <>
          <button
            onClick={() => setWhy((v) => !v)}
            className="flex w-full items-center gap-1.5 border-t border-[#f0f2f5] px-3 py-2 text-left text-[10px] font-semibold text-[#5a6675] transition hover:bg-[#f7f8fa]"
          >
            <Info className="size-3 shrink-0 text-[#8b97a5]" />
            <span className="flex-1">Why this rank?</span>
            {why ? <ChevronUp className="size-3 text-[#a3acb7]" /> : <ChevronDown className="size-3 text-[#a3acb7]" />}
          </button>
          {why && <WhyPanel post={post} score={score} error={error} />}
        </>
      )}

      {/* Transcript panel — outside the <a> so clicks don't navigate */}
      {hasTranscript && post.transcript && (
        <TranscriptPanel transcript={post.transcript} postCode={post.code} />
      )}
    </div>
  )
}

function UpgradeWall({ onUpgrade, loading }: { onUpgrade: () => void; loading: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <div className="mb-6 flex size-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#17202b] to-[#2b3948] shadow-lg">
        <Zap className="size-8 text-white" />
      </div>
      <h2 className="text-xl font-bold tracking-tight text-[#17202b]">Unlock Instagram Search</h2>
      <p className="mt-2 max-w-sm text-sm text-[#657180]">
        Subscribe to run unlimited searches across posts, reels, hashtags, and places.
      </p>

      <ul className="mt-6 space-y-2 text-left text-sm text-[#273442]">
        {[
          'Unlimited hashtag & keyword searches',
          'Top posts, reels, carousels & places',
          'Up to 500 results per query',
          'Full search history saved',
        ].map((f) => (
          <li key={f} className="flex items-center gap-2">
            <Star className="size-3.5 shrink-0 text-[#17202b]" />
            {f}
          </li>
        ))}
      </ul>

      <button
        onClick={onUpgrade}
        disabled={loading}
        className="mt-8 flex items-center gap-2 rounded-xl bg-[#17202b] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#2b3948] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#17202b] focus-visible:ring-offset-2"
      >
        {loading ? (
          <>
            <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            Redirecting…
          </>
        ) : (
          <>
            <CreditCard className="size-4" />
            Subscribe — Get Started
          </>
        )}
      </button>
      <p className="mt-3 text-xs text-[#a3acb7]">Secure checkout via Stripe · Cancel anytime</p>
    </div>
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
  const [checkoutLoading, setCheckoutLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRecord, setActiveRecord] = useState<SearchRecord | null>(null)
  const [history, setHistory] = useState<SearchRecord[]>([])
  const [igAccount, setIgAccount] = useState<InstagramStatus | null>(null)
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const [billing, setBilling] = useState<BillingStatus | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('relevance')
  const [recencyDays, setRecencyDays] = useState<number | null>(null)
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [scores, setScores] = useState<Record<string, PostScore>>({})
  const [scoreErrors, setScoreErrors] = useState<Record<string, string>>({})
  const [scoreStatus, setScoreStatus] = useState<ScoreStatus>({ state: 'idle' })
  const [scoreTick, setScoreTick] = useState(0)
  const [hideOff, setHideOff] = useState(false)
  const [activeTopic, setActiveTopic] = useState<string | null>(null)
  const [activeFormat, setActiveFormat] = useState<string | null>(null)
  const userSorted = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Load history + Instagram status + billing on mount ───────────────────
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

    fetch('/api/billing/status')
      .then((r) => r.json())
      .then((data: BillingStatus) => setBilling(data))
      .catch(() => setBilling({ active: false, status: null, current_period_end: null, has_customer: false }))

    // Handle post-checkout redirect
    const params = new URLSearchParams(window.location.search)
    if (params.get('checkout') === 'success') {
      // Poll until billing is confirmed active (webhook may be slightly delayed)
      const poll = setInterval(async () => {
        const r = await fetch('/api/billing/status')
        const d: BillingStatus = await r.json()
        setBilling(d)
        if (d.active) clearInterval(poll)
      }, 2000)
      setTimeout(() => clearInterval(poll), 30_000) // give up after 30s
      window.history.replaceState({}, '', '/search')
    }
    if (params.get('checkout') === 'cancel') {
      window.history.replaceState({}, '', '/search')
    }
  }, [])

  // ── Supabase sign out ─────────────────────────────────────────────────────
  async function handleSignOut() {
    // createClient() called here so it only runs in the browser, never during SSR
    await createClient().auth.signOut()
    window.location.href = '/login'
  }

  // ── Stripe checkout ───────────────────────────────────────────────────────
  async function startCheckout() {
    setCheckoutLoading(true)
    try {
      const r = await fetch('/api/stripe/checkout', { method: 'POST' })
      const d = await r.json()
      if (d.url) window.location.href = d.url
      else setError(d.error ?? 'Could not start checkout.')
    } finally {
      setCheckoutLoading(false)
    }
  }

  // ── Stripe portal ─────────────────────────────────────────────────────────
  async function openPortal() {
    setCheckoutLoading(true)
    try {
      const r = await fetch('/api/stripe/portal', { method: 'POST' })
      const d = await r.json()
      if (d.url) window.location.href = d.url
      else setError(d.error ?? 'Could not open billing portal.')
    } finally {
      setCheckoutLoading(false)
    }
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
        if (res.status === 402) {
          setBilling((b) => b ? { ...b, active: false } : { active: false, status: null, current_period_end: null, has_customer: false })
          return
        }
        if (res.status === 401 && data.code === 'SESSION_EXPIRED') {
          // Instagram session is too old — prompt reconnect without showing a raw error
          setIgAccount({ connected: false, username: null, user_id: null, created_at: null })
          setError('Your Instagram session has expired. Please reconnect your account using the account menu above.')
          return
        }
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

  const allPosts = activeRecord?.results ?? []
  // recency → hashtag → off-brand → topic/format → sort
  const { posts, hiddenCount, topicCounts, formatCounts } = useMemo(() => {
    const recent = allPosts.filter((p) => withinDays(p, recencyDays))
    const tagged = activeTag ? recent.filter((p) => extractHashtags(p.caption).includes(activeTag)) : recent
    const isOff = (p: PostResult) => (p.code && scores[p.code] ? scores[p.code].fit < OFF_BRAND_FIT : false)
    const hiddenCount = tagged.filter(isOff).length
    const visible = hideOff ? tagged.filter((p) => !isOff(p)) : tagged
    const sc = (p: PostResult) => (p.code ? scores[p.code] : undefined)
    const faceted = visible.filter(
      (p) => (!activeTopic || sc(p)?.topic === activeTopic) && (!activeFormat || sc(p)?.format === activeFormat),
    )
    return {
      posts: sortPosts(faceted, sortKey, (p) => {
        const s = sc(p)
        return s ? rankScore(s.fit, p).score : null
      }),
      hiddenCount,
      topicCounts: countBy(visible, (p) => sc(p)?.topic),
      formatCounts: countBy(visible, (p) => sc(p)?.format),
    }
  }, [allPosts, recencyDays, activeTag, hideOff, activeTopic, activeFormat, sortKey, scores])

  // New record → drop per-record filters and manual-sort flag (tags/facets rarely carry over).
  useEffect(() => {
    setActiveTag(null)
    setActiveTopic(null)
    setActiveFormat(null)
    setSortKey('relevance')
    userSorted.current = false
  }, [activeRecord?.id])

  // ── Brand-fit scoring: whenever the active record changes (or Retry) ──────
  useEffect(() => {
    const codes = (activeRecord?.results ?? []).filter((p) => p.code)
    if (codes.length === 0) { setScoreStatus({ state: 'idle' }); return }
    let stale = false
    setScoreStatus({ state: 'loading', n: codes.length })
    const chunks: PostResult[][] = []
    for (let i = 0; i < codes.length; i += 200) chunks.push(codes.slice(i, i + 200))
    ;(async () => {
      const usage: ScoreUsage = { calls: 0, cached: 0, inputTokens: 0, usd: 0, ms: 0 }
      const t0 = Date.now()
      let failure: string | null = null
      await Promise.all(chunks.map(async (posts) => {
        try {
          const res = await fetch('/api/score', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ posts }),
          })
          const d = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(d.error ?? `Scoring failed (${res.status})`)
          if (stale) return
          setScores((prev) => ({ ...prev, ...d.scores }))
          setScoreErrors((prev) => ({ ...prev, ...d.errors }))
          for (const k of ['calls', 'cached', 'inputTokens', 'usd'] as const) usage[k] += d.usage?.[k] ?? 0
        } catch (e) {
          failure = e instanceof Error ? e.message : 'Network error'
        }
      }))
      if (stale) return
      usage.ms = Date.now() - t0
      if (failure) setScoreStatus({ state: 'error', message: failure })
      else {
        setScoreStatus({ state: 'done', n: codes.length, usage })
        if (!userSorted.current) setSortKey('fit')
      }
    })()
    return () => { stale = true }
  }, [activeRecord, scoreTick])

  const scored = scoreStatus.state === 'done' || codeScored(allPosts, scores)

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

          {/* Billing section — only shown when gate is enabled */}
          {BILLING_GATE_ENABLED && <div className="border-t border-[#edf0f3]">
            {billing === null ? (
              // Loading skeleton
              <div className="flex items-center gap-2.5 px-4 py-3">
                <div className="size-7 animate-pulse rounded-full bg-[#edf0f3]" />
                <div className="h-3 w-20 animate-pulse rounded bg-[#edf0f3]" />
              </div>
            ) : billing.active ? (
              <button
                onClick={openPortal}
                disabled={checkoutLoading}
                className="flex w-full items-center gap-2.5 px-4 py-3 transition hover:bg-[#f7f8fa] disabled:opacity-60"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[#17202b]">
                  <CreditCard className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-xs font-semibold text-[#273442]">Pro Plan</p>
                  <p className="text-[10px] text-[#a3acb7]">Manage billing</p>
                </div>
              </button>
            ) : (
              <button
                onClick={startCheckout}
                disabled={checkoutLoading}
                className="flex w-full items-center gap-2.5 px-4 py-3 transition hover:bg-[#f7f8fa] disabled:opacity-60"
              >
                <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#17202b] to-[#2b3948]">
                  <Zap className="size-3.5 text-white" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <p className="text-xs font-semibold text-[#273442]">Upgrade to Pro</p>
                  <p className="text-[10px] text-[#a3acb7]">Unlock all searches</p>
                </div>
              </button>
            )}
          </div>}

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
              autoComplete="off"
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
        <div className="flex flex-1 flex-col overflow-y-auto">
          {BILLING_GATE_ENABLED && billing !== null && !billing.active ? (
            <UpgradeWall onUpgrade={startCheckout} loading={checkoutLoading} />
          ) : !BILLING_GATE_ENABLED || billing?.active ? (
            <div className="flex-1 px-6 py-6">
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
                  <p className="text-xs text-[#a3acb7]">Fetching reels and transcribing audio — this may take a minute.</p>
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
                        {posts.length} shown of {allPosts.length} ·{' '}
                        {activeRecord.search_type} ·{' '}
                        {timeAgo(activeRecord.timestamp)}
                      </p>
                    </div>
                  </div>

                  {allPosts.length > 0 && (
                    <div className="mb-4 flex flex-wrap items-center gap-3 text-xs">
                      <label className="flex items-center gap-1.5 font-medium text-[#8994a1]">
                        Sort
                        <select
                          value={sortKey}
                          onChange={(e) => { userSorted.current = true; setSortKey(e.target.value as SortKey) }}
                          className="cursor-pointer rounded-lg border border-[#d9dfe6] bg-[#f8f9fb] px-2.5 py-1.5 font-semibold text-[#273442] outline-none transition focus:border-[#17202b]"
                        >
                          {(Object.keys(SORT_LABELS) as SortKey[]).filter((k) => k !== 'fit' || scored).map((k) => (
                            <option key={k} value={k}>{SORT_LABELS[k]}</option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1.5 font-medium text-[#8994a1]">
                        Posted
                        <select
                          value={recencyDays ?? ''}
                          onChange={(e) => setRecencyDays(e.target.value ? Number(e.target.value) : null)}
                          className="cursor-pointer rounded-lg border border-[#d9dfe6] bg-[#f8f9fb] px-2.5 py-1.5 font-semibold text-[#273442] outline-none transition focus:border-[#17202b]"
                        >
                          {RECENCY_OPTIONS.map((o) => (
                            <option key={o.label} value={o.value ?? ''}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                      <label
                        className={`flex items-center gap-1.5 font-medium ${scored ? 'cursor-pointer text-[#273442]' : 'cursor-not-allowed text-[#a3acb7]'}`}
                      >
                        <input
                          type="checkbox"
                          checked={hideOff}
                          disabled={!scored}
                          onChange={(e) => setHideOff(e.target.checked)}
                          className="size-3.5 accent-[#17202b]"
                        />
                        Hide off-brand
                        {scored && hideOff && <span className="text-[#8994a1]">({hiddenCount} hidden)</span>}
                        {scored && !hideOff && hiddenCount > 0 && <span className="text-[#8994a1]">({hiddenCount} would hide)</span>}
                      </label>
                      <span
                        title={`Scored against: ${BRAND_BRIEF.audience}\nThemes: ${BRAND_BRIEF.themes.join(', ')}\nAvoid: ${BRAND_BRIEF.avoid.join(', ')}`}
                        className="flex cursor-help items-center gap-1 text-[#8994a1]"
                      >
                        <Info className="size-3.5" />
                        Scoring against: {BRAND_BRIEF.audience.replace(/\.$/, '')}
                      </span>
                      {scoreStatus.state === 'loading' && (
                        <span className="flex items-center gap-1.5 text-[#657180]">
                          <span className="size-3 animate-spin rounded-full border-2 border-[#d9dfe6] border-t-[#17202b]" />
                          Scoring brand fit… ({scoreStatus.n} posts)
                        </span>
                      )}
                      {scoreStatus.state === 'done' && (
                        <span className="text-[#657180]">
                          Scored {scoreStatus.n} posts · {Math.round(scoreStatus.usage.ms)} ms · ${scoreStatus.usage.usd.toFixed(4)}
                          {scoreStatus.usage.cached > 0 && ` · ${scoreStatus.usage.cached} cached`}
                          {Object.keys(scoreErrors).length > 0 && ` · ${Object.keys(scoreErrors).length} failed`}
                        </span>
                      )}
                      {scoreStatus.state === 'error' && (
                        <span className="flex items-center gap-1.5 rounded-lg bg-[#fff5f5] px-2 py-1 text-[#9b2c2c]">
                          Scoring failed: {scoreStatus.message}
                          <button onClick={() => setScoreTick((t) => t + 1)} className="font-semibold underline">Retry</button>
                        </span>
                      )}
                      {activeTag && (
                        <button
                          onClick={() => setActiveTag(null)}
                          title="Clear hashtag filter"
                          className="flex items-center gap-1 rounded-lg bg-[#17202b] px-2.5 py-1.5 font-semibold text-white transition hover:bg-[#2b3948]"
                        >
                          #{activeTag}
                          <X className="size-3" />
                        </button>
                      )}
                    </div>
                  )}

                  {scored && (topicCounts.length > 0 || formatCounts.length > 0) && (
                    <div className="mb-4 space-y-1.5">
                      {([
                        ['Topic', topicCounts, activeTopic, setActiveTopic],
                        ['Format', formatCounts, activeFormat, setActiveFormat],
                      ] as const).map(([name, counts, active, setActive]) => (
                        <div key={name} className="flex flex-wrap items-center gap-1.5 text-[11px]">
                          <span className="w-12 font-medium text-[#8994a1]">{name}</span>
                          {counts.map(([id, n]) => (
                            <button
                              key={id}
                              onClick={() => setActive(active === id ? null : id)}
                              className={`rounded-full px-2.5 py-1 font-semibold transition ${
                                active === id ? 'bg-[#17202b] text-white' : 'bg-[#f0f2f5] text-[#5a6675] hover:bg-[#e5e8ec] hover:text-[#17202b]'
                              }`}
                            >
                              {humanLabel(id)} <span className={active === id ? 'text-white/70' : 'text-[#8994a1]'}>{n}</span>
                            </button>
                          ))}
                          {active && !counts.some(([id]) => id === active) && (
                            <span className="text-[#8994a1]">{humanLabel(active)} (0 visible)</span>
                          )}
                          {active && (
                            <button onClick={() => setActive(null)} className="flex items-center gap-0.5 text-[#657180] underline">
                              <X className="size-3" /> clear
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {allPosts.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[#d9dfe6] bg-white px-6 py-16 text-center">
                      <Search className="mx-auto mb-3 size-8 text-[#c8cdd3]" />
                      <p className="text-sm font-medium text-[#657180]">No posts found.</p>
                      <p className="mt-1 text-xs text-[#a3acb7]">Try a different query or search type.</p>
                    </div>
                  ) : posts.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[#d9dfe6] bg-white px-6 py-16 text-center">
                      <Search className="mx-auto mb-3 size-8 text-[#c8cdd3]" />
                      <p className="text-sm font-medium text-[#657180]">No posts match these filters.</p>
                      <button
                        onClick={() => { setRecencyDays(null); setActiveTag(null); setHideOff(false); setActiveTopic(null); setActiveFormat(null) }}
                        className="mt-3 rounded-lg bg-[#17202b] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2b3948]"
                      >
                        Clear filters
                      </button>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                      {posts.map((post, i) => (
                        <PostCard
                          key={`${activeRecord.id}-${post.pk ?? post.code ?? i}`}
                          post={post}
                          score={post.code ? scores[post.code] : undefined}
                          error={post.code ? scoreErrors[post.code] : undefined}
                          onTag={setActiveTag}
                        />
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
          ) : null}
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
