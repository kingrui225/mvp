/**
 * Refresh public post metrics from Apify's Instagram Post Scraper.
 * Search still discovers posts. This replaces caption and counts using each post URL.
 * Without APIFY_TOKEN, the original search counts are kept.
 */

const ACTOR = 'apify~instagram-post-scraper'
const TIMEOUT_SECONDS = 90

interface ApifyPost {
  shortCode?: string
  url?: string
  caption?: string
  likesCount?: number
  commentsCount?: number
  videoPlayCount?: number
  videoViewCount?: number
  displayUrl?: string
  videoUrl?: string
  ownerUsername?: string
  timestamp?: string
}

interface MetricPost {
  code?: string
  url?: string
  caption?: string
  like_count?: number
  comment_count?: number
  view_count?: number
  thumbnail_url?: string
  video_url?: string
  username?: string
  taken_at?: string
}

function postUrl(post: MetricPost): string | null {
  if (post.url) return post.url
  if (post.code) return `https://www.instagram.com/p/${post.code}/`
  return null
}

function shortCodeFrom(item: ApifyPost): string | null {
  if (item.shortCode) return item.shortCode
  const match = item.url?.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/)
  return match?.[1] ?? null
}

/** A public count. -1 means the creator hid it, so it is not a real total. */
function publicCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

export async function enrichPostsFromApify<T extends MetricPost>(posts: T[]): Promise<T[]> {
  const token = process.env.APIFY_TOKEN?.trim()
  if (!token || posts.length === 0) return posts

  const urls = posts.map(postUrl).filter((url): url is string => Boolean(url))
  if (urls.length === 0) return posts

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (TIMEOUT_SECONDS + 15) * 1000)

  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?timeout=${TIMEOUT_SECONDS}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          username: urls,
          dataDetailLevel: 'basicData',
        }),
        signal: controller.signal,
      },
    )

    if (!res.ok) {
      const body = await res.text()
      console.error('[apify] post scraper status=%d body=%s', res.status, body.slice(0, 300))
      return posts
    }

    const items = (await res.json()) as ApifyPost[]
    if (!Array.isArray(items) || items.length === 0) {
      console.error('[apify] post scraper returned no items for %d urls', urls.length)
      return posts
    }

    const byCode = new Map<string, ApifyPost>()
    for (const item of items) {
      const code = shortCodeFrom(item)
      if (code) byCode.set(code, item)
    }

    let updated = 0
    const enriched = posts.map((post) => {
      if (!post.code) return post
      const item = byCode.get(post.code)
      if (!item) return post
      updated += 1

      const likes = publicCount(item.likesCount)
      const comments = publicCount(item.commentsCount)
      const views = publicCount(item.videoPlayCount) ?? publicCount(item.videoViewCount)
      const caption = typeof item.caption === 'string' && item.caption.trim() ? item.caption : undefined

      return {
        ...post,
        caption: caption ?? post.caption,
        like_count: item.likesCount === -1 ? undefined : (likes ?? post.like_count),
        comment_count: comments ?? post.comment_count,
        view_count: views ?? post.view_count,
        thumbnail_url: item.displayUrl || post.thumbnail_url,
        video_url: item.videoUrl || post.video_url,
        username: item.ownerUsername || post.username,
        taken_at: item.timestamp || post.taken_at,
      }
    })

    console.log('[apify] updated %d of %d posts', updated, posts.length)
    return enriched
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[apify] post scraper failed: %s', message)
    return posts
  } finally {
    clearTimeout(timer)
  }
}
