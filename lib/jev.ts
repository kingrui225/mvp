import type { PostResult } from '@/app/api/search/route'
import { BRAND_BRIEF } from './brand-brief'

const JEV_MODEL = 'jev-1.13.0'
const USD_PER_M_INPUT = 0.042

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JevAnswers = Record<string, any>

const RETRYABLE = [429, 500, 502, 503, 529]

/** One Jev System One request: all questions answered against one state. Retries 429/5xx with backoff. */
export async function systemOne(
  state: object,
  questions: Record<string, JevQuestion>,
  opts: { backoffMs?: number } = {},
): Promise<{ answers: JevAnswers; usage: { input_tokens: number; output_tokens: number } }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
    })
    if (res.ok) return res.json()
    if (!RETRYABLE.includes(res.status) || attempt >= 4) throw new Error(`Jev ${res.status}: ${(await res.text()).slice(0, 300)}`)
    await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 500) * 2 ** attempt))
  }
}

export const TOPICS = ['party', 'nightlife', 'sports_gameday', 'campus_life', 'greek_life', 'music', 'comedy_memes', 'dating', 'fashion_beauty', 'food', 'travel', 'news', 'other'] as const
export const FORMATS = ['pov', 'skit', 'vlog', 'talking_head', 'montage_edit', 'tutorial', 'photo_carousel', 'other'] as const
export const HOOKS = ['question', 'bold_claim', 'relatable', 'pov_setup', 'tease_wait_for_it', 'visual_only', 'none', 'other'] as const

const choice = (instructions: string, options: readonly string[], desc: Record<string, string> = {}): JevQuestion => ({
  type: 'choice',
  instructions,
  criteria: Object.fromEntries(options.map((o) => [o, desc[o] ?? null])),
})

export const POST_QUESTIONS: Record<string, JevQuestion> = {
  brand_fit: {
    type: 'score',
    instructions: 'How well does this Instagram post (`caption`, `transcript`, `hashtags`) fit the world of `brand` (its themes, audience and product)?',
    criteria: [
      'Unrelated: nothing in the post connects to the brand themes or audience.',
      'Weak: tangentially related, or the right audience but a different world.',
      'Good: clearly in one of the brand themes and relevant to the audience.',
      'Squarely in the brand world: exactly the content a college-student audience of this brand would make or share.',
    ],
  },
  audience_fit: {
    type: 'noul',
    instructions: 'Would `brand.audience` stop scrolling and engage with this post (`caption`, `transcript`, `hashtags`)?',
  },
  topic: choice('What is the main topic of this post (`caption`, `transcript`, `hashtags`)?', TOPICS, {
    party: 'house parties, social gatherings, celebrations',
    nightlife: 'clubs, bars, going out',
    sports_gameday: 'college sports, game days, tailgates',
    campus_life: 'dorms, classes, college daily life',
    greek_life: 'fraternities, sororities, rush, bid day',
    comedy_memes: 'jokes, memes, funny skits',
    news: 'news, tragedy, politics',
    other: 'none of the above',
  }),
  format: choice('What is the content format of this post (`caption`, `transcript`, `media_type`)?', FORMATS, {
    pov: 'point-of-view scenario',
    skit: 'acted comedic scene',
    vlog: 'day-in-the-life style',
    talking_head: 'person talking to camera',
    montage_edit: 'fast-cut edit of clips with music',
    tutorial: 'how-to or tips',
    photo_carousel: 'slideshow of photos',
  }),
  hook: choice('What kind of hook opens this post (`caption`, `transcript`)?', HOOKS, {
    question: 'opens with a question',
    bold_claim: 'strong or surprising statement',
    relatable: 'relatable situation ("when you...")',
    pov_setup: 'POV: ... setup',
    tease_wait_for_it: 'teases a payoff later',
    visual_only: 'no words, the visual carries it',
    none: 'no discernible hook',
  }),
  sponsored: { type: 'noul', instructions: 'Is this post a paid partnership or brand deal (`caption`, `hashtags`)?' },
  junk: {
    type: 'noul',
    instructions: 'Is this post news/tragedy, a giveaway, a repost/aggregator page, or an unrelated product ad (see `brand.avoid`)?',
  },
}

export function postState(post: PostResult, now = Date.now()) {
  const caption = post.caption ?? ''
  const age = post.taken_at ? (now - new Date(post.taken_at).getTime()) / 86_400_000 : undefined
  return {
    caption: caption.slice(0, 1000),
    hashtags: caption.match(/#[\p{L}\p{N}_]+/gu)?.slice(0, 30) ?? [],
    media_type: post.media_type,
    username: post.username,
    likes: post.like_count,
    comments: post.comment_count,
    views: post.view_count,
    age_days: age !== undefined && Number.isFinite(age) ? Math.round(age * 10) / 10 : undefined,
    ...(post.transcript?.text ? { transcript: post.transcript.text.slice(0, 1200) } : {}),
    brand: BRAND_BRIEF,
  }
}

export interface PostScore {
  code: string
  fit: number
  fitBreakdown: { brandFit: number; audienceFit: number; junkPenalty: number }
  topic: string
  topicConfidence: number
  format: string
  formatConfidence: number
  hook: string
  hookConfidence: number
  sponsored: number
  junk: number
  answers: JevAnswers
  ms: number
  inputTokens: number
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** fit = (brand_fit/3) * (0.5 + 0.5*audience_fit) * (1 - junk), all in 0..1. */
export function fitScore(a: JevAnswers) {
  const brandFit = clamp01((a.brand_fit?.score ?? 0) / 3)
  const audienceFit = clamp01(a.audience_fit?.noul ?? 0)
  const junkPenalty = clamp01(a.junk?.noul ?? 0)
  return { fit: brandFit * (0.5 + 0.5 * audienceFit) * (1 - junkPenalty), brandFit, audienceFit, junkPenalty }
}

/** rank = fit * (0.5+0.5*recency) * (0.5+0.5*engNorm); unknown recency/engagement count as 0.5. */
export function rankScore(fit: number, post: PostResult, now = Date.now()) {
  const age = post.taken_at ? (now - new Date(post.taken_at).getTime()) / 86_400_000 : NaN
  const recency = Number.isFinite(age) ? Math.exp(-Math.max(0, age) / 30) : 0.5
  const views = post.view_count
  const eng = views && views > 0 && (post.like_count != null || post.comment_count != null)
    ? ((post.like_count ?? 0) + (post.comment_count ?? 0)) / views
    : NaN
  const engNorm = Number.isFinite(eng) ? Math.min(1, eng / 0.1) : 0.5
  return { score: fit * (0.5 + 0.5 * recency) * (0.5 + 0.5 * engNorm), recency, engNorm }
}

const cache = new Map<string, PostScore>() // ponytail: unbounded in-process cache; add LRU/TTL if memory matters

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++])
  }))
}

export async function scorePosts(posts: PostResult[], { concurrency = 8 } = {}) {
  const scores: Record<string, PostScore> = {}
  const errors: Record<string, string> = {}
  const usage = { calls: 0, cached: 0, inputTokens: 0, usd: 0, ms: 0 }
  const t0 = Date.now()
  const todo: (PostResult & { code: string })[] = []
  for (const p of posts) {
    if (!p.code) continue
    const hit = cache.get(p.code)
    if (hit) { scores[p.code] = hit; usage.cached++ } else todo.push(p as PostResult & { code: string })
  }
  await mapLimit(todo, concurrency, async (p) => {
    const t = Date.now()
    try {
      const { answers, usage: u } = await systemOne(postState(p), POST_QUESTIONS)
      const f = fitScore(answers)
      const s: PostScore = {
        code: p.code,
        fit: f.fit,
        fitBreakdown: { brandFit: f.brandFit, audienceFit: f.audienceFit, junkPenalty: f.junkPenalty },
        topic: answers.topic?.choice, topicConfidence: answers.topic?.confidence ?? 0,
        format: answers.format?.choice, formatConfidence: answers.format?.confidence ?? 0,
        hook: answers.hook?.choice, hookConfidence: answers.hook?.confidence ?? 0,
        sponsored: answers.sponsored?.noul ?? 0,
        junk: answers.junk?.noul ?? 0,
        answers, ms: Date.now() - t, inputTokens: u?.input_tokens ?? 0,
      }
      cache.set(p.code, s)
      scores[p.code] = s
      usage.calls++
      usage.inputTokens += s.inputTokens
    } catch (e) {
      errors[p.code] = e instanceof Error ? e.message : String(e)
    }
  })
  usage.usd = (usage.inputTokens / 1e6) * USD_PER_M_INPUT
  usage.ms = Date.now() - t0
  return { scores, errors, usage }
}
