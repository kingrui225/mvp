// Pure helpers for ranking/filtering Instagram posts on the client.

export interface MetricsPost {
  caption?: string
  like_count?: number
  comment_count?: number
  view_count?: number
  taken_at?: string
}

// Add new keys here + SORT_LABELS + a case in sortValue. 'fit' is not a metric: its value comes from the `valueOf` arg of sortPosts.
export type SortKey = 'relevance' | 'newest' | 'views' | 'likes' | 'engagement' | 'fit'

export const SORT_LABELS: Record<SortKey, string> = {
  relevance: 'Instagram relevance',
  newest: 'Newest',
  views: 'Most views',
  likes: 'Most likes',
  engagement: 'Engagement rate',
  fit: 'Brand fit (smart)',
}

export function extractHashtags(caption?: string): string[] {
  if (!caption) return []
  const tags = Array.from(caption.matchAll(/#([\p{L}\p{N}_]+)/gu), (m) => m[1].toLowerCase())
  return Array.from(new Set(tags))
}

export function engagementRate(p: MetricsPost): number | null {
  if (!p.view_count) return null
  return ((p.like_count ?? 0) + (p.comment_count ?? 0)) / p.view_count
}

export function withinDays(p: MetricsPost, days: number | null, now = Date.now()): boolean {
  if (days == null) return true
  const t = p.taken_at ? new Date(p.taken_at).getTime() : NaN
  if (Number.isNaN(t)) return false
  return now - t <= days * 86_400_000
}

function sortValue(p: MetricsPost, key: SortKey): number | null {
  switch (key) {
    case 'newest': {
      const t = p.taken_at ? new Date(p.taken_at).getTime() : NaN
      return Number.isNaN(t) ? null : t
    }
    case 'views': return p.view_count ?? null
    case 'likes': return p.like_count ?? null
    case 'engagement': return engagementRate(p)
    default: return null
  }
}

/** Returns a new array. 'relevance' keeps Instagram's order; missing values sort last; stable. 'fit' uses `valueOf` (e.g. rank score by post code). */
export function sortPosts<T extends MetricsPost>(posts: T[], key: SortKey, valueOf?: (p: T) => number | null): T[] {
  const out = [...posts]
  if (key === 'relevance') return out
  const vals = new Map(out.map((p) => [p, key === 'fit' ? (valueOf?.(p) ?? null) : sortValue(p, key)] as const))
  return out.sort((a, b) => {
    const x = vals.get(a), y = vals.get(b)
    if (x == null) return y == null ? 0 : 1
    if (y == null) return -1
    return y - x
  })
}

const LABELS: Record<string, string> = {
  pov: 'POV',
  pov_setup: 'POV setup',
  sports_gameday: 'Sports / gameday',
  comedy_memes: 'Comedy / memes',
  fashion_beauty: 'Fashion / beauty',
  tease_wait_for_it: 'Tease / wait for it',
}

/** 'sports_gameday' -> 'Sports / gameday'; unknown ids are sentence-cased. */
export function humanLabel(id: string): string {
  if (LABELS[id]) return LABELS[id]
  const s = id.replace(/_/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const OFF_BRAND_FIT = 0.35
export const GOOD_FIT = 0.6

export function fitTone(fit: number): 'high' | 'mid' | 'low' {
  return fit >= GOOD_FIT ? 'high' : fit >= OFF_BRAND_FIT ? 'mid' : 'low'
}

/** [value, count] pairs, most frequent first (ties alphabetical). Falsy values are skipped. */
export function countBy<T>(items: T[], key: (x: T) => string | undefined): [string, number][] {
  const m = new Map<string, number>()
  for (const it of items) {
    const k = key(it)
    if (k) m.set(k, (m.get(k) ?? 0) + 1)
  }
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** Top-n alternatives from a Jev choice answer's `probabilities` (object or [{choice,probability}] array). */
export function topAlternatives(answer: unknown, n = 3): [string, number][] {
  const probs = (answer as { probabilities?: unknown } | undefined)?.probabilities
  let pairs: [string, number][] = []
  if (Array.isArray(probs)) {
    pairs = probs.flatMap((x) => {
      const k = x?.choice ?? x?.label ?? x?.name
      const v = x?.probability ?? x?.p ?? x?.score
      return typeof k === 'string' && typeof v === 'number' ? [[k, v] as [string, number]] : []
    })
  } else if (probs && typeof probs === 'object') {
    pairs = Object.entries(probs).filter((e): e is [string, number] => typeof e[1] === 'number')
  }
  return pairs.sort((a, b) => b[1] - a[1]).slice(0, n)
}
