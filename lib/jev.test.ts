import { readdirSync, readFileSync } from 'fs'
import type { PostResult } from '../app/api/search/route'
import { FORMATS, HOOKS, TOPICS, fitScore, postState, rankScore, scorePosts } from './jev'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

function testFitScore() {
  const f = fitScore({ brand_fit: { score: 3 }, audience_fit: { noul: 1 }, junk: { noul: 0 } })
  assert(near(f.fit, 1), 'perfect answers => fit 1')
  assert(near(fitScore({ brand_fit: { score: 3 }, audience_fit: { noul: 0 }, junk: { noul: 0 } }).fit, 0.5), 'audience 0 halves fit')
  assert(near(fitScore({ brand_fit: { score: 3 }, audience_fit: { noul: 1 }, junk: { noul: 1 } }).fit, 0), 'junk 1 => fit 0')
  assert(near(fitScore({ brand_fit: { score: 0 }, audience_fit: { noul: 1 }, junk: { noul: 0 } }).fit, 0), 'brand 0 => fit 0')
  assert(near(fitScore({ brand_fit: { score: 2 }, audience_fit: { noul: 0.5 }, junk: { noul: 0.2 } }).fit, (2 / 3) * 0.75 * 0.8), 'formula')
}

function testRankScore() {
  const now = Date.parse('2026-01-31T00:00:00Z')
  const fresh = rankScore(1, { taken_at: '2026-01-31T00:00:00Z', view_count: 1000, like_count: 100 }, now)
  assert(near(fresh.recency, 1) && near(fresh.engNorm, 1) && near(fresh.score, 1), 'fresh + 10% engagement => 1')
  const unknown = rankScore(1, {}, now)
  assert(unknown.recency === 0.5 && unknown.engNorm === 0.5 && near(unknown.score, 0.75 * 0.75), 'unknown => 0.5s')
  const old = rankScore(1, { taken_at: '2026-01-01T00:00:00Z' }, now)
  assert(near(old.recency, Math.exp(-1)), '30 days => e^-1')
}

function testPostState() {
  const now = Date.parse('2026-01-11T00:00:00Z')
  const s = postState({ caption: 'x'.repeat(2000) + ' #Frat_life', taken_at: '2026-01-01T00:00:00Z', transcript: { text: 'y'.repeat(3000) }, username: 'u' }, now)
  assert(s.caption.length === 1000, 'caption truncated')
  assert(s.age_days === 10, 'age in days')
  assert(s.transcript?.length === 1200, 'transcript truncated')
  assert(postState({ caption: 'hi #a #b' }).hashtags.join() === '#a,#b', 'hashtags parsed')
  assert(!('transcript' in postState({ caption: 'hi' })), 'no transcript key when absent')
  assert(postState({}).brand.audience.length > 0, 'brand included')
}

const ANCHORS = [
  'POV: you and the girls pregaming before the frat party at ASU tonight #collegelife #partytime #greeklife',
  'when the whole dorm floor shows up to gameday tailgate lol #gameday #college #tailgate #fyp',
  'sorority bid day reaction, im crying omg #bidday #sororitylife #rush',
  'Friday night at the club with my roommates, college nightlife hits different #nightlife #college #party',
  'POV: your roommate swapped faces with the whole campus for the group chat meme #memes #college #funny',
]

async function testLive() {
  try { process.loadEnvFile?.('.env') } catch { /* no .env */ }
  if (!process.env.TYPESAFE_API_KEY) return console.log('LIVE section skipped: TYPESAFE_API_KEY not set')
  const dir = '/Users/adamkuca/dev/projects/agenticFruit/jev-bench-data/apify-cache'
  const real: PostResult[] = []
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    for (const i of JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')).items ?? []) {
      if (!i.shortCode || !i.caption) continue
      const tags = (i.hashtags ?? []).map((h: string) => `#${h}`).join(' ')
      real.push({
        code: i.shortCode, url: i.url, caption: `${i.caption}${i.caption.includes('#') ? '' : ' ' + tags}`,
        media_type: i.type === 'Video' ? 'video' : i.type === 'Sidecar' ? 'carousel' : 'photo',
        like_count: i.likesCount, comment_count: i.commentsCount,
        view_count: i.videoPlayCount ?? i.videoViewCount ?? undefined,
        username: i.ownerUsername, taken_at: i.timestamp,
      })
    }
  }
  const sample = real.filter((_, i) => i % Math.max(1, Math.floor(real.length / 25)) === 0).slice(0, 25)
  const anchors: PostResult[] = ANCHORS.map((caption, i) => ({ code: `anchor${i}`, caption, media_type: 'video', username: 'anchor' }))
  const { scores, errors, usage } = await scorePosts([...sample, ...anchors])
  assert(Object.keys(errors).length === 0, `live errors: ${JSON.stringify(errors).slice(0, 400)}`)
  const all = Object.values(scores)
  assert(all.length === sample.length + anchors.length, 'every post scored')
  console.log('sample raw brand_fit answer keys:', Object.keys(all[0].answers.brand_fit).join(','), '| score', all[0].answers.brand_fit.score, 'conf', all[0].answers.brand_fit.confidence)
  for (const s of all) {
    const a = s.answers
    assert(typeof a.brand_fit?.score === 'number' && a.brand_fit.score >= 0 && a.brand_fit.score <= 3, `${s.code} brand_fit score`)
    for (const k of ['audience_fit', 'sponsored', 'junk']) assert(a[k]?.noul >= 0 && a[k].noul <= 1, `${s.code} ${k} noul`)
    for (const [k, opts] of [['topic', TOPICS], ['format', FORMATS], ['hook', HOOKS]] as const) {
      assert((opts as readonly string[]).includes(a[k]?.choice), `${s.code} ${k} choice ${a[k]?.choice}`)
      assert(a[k].confidence >= 0 && a[k].confidence <= 1, `${s.code} ${k} confidence`)
    }
    assert(s.fit >= 0 && s.fit <= 1, `${s.code} fit range`)
  }
  const mean = (xs: PostScore[]) => xs.reduce((t, s) => t + s.fit, 0) / xs.length
  const aMean = mean(all.filter((s) => s.code.startsWith('anchor')))
  const rMean = mean(all.filter((s) => !s.code.startsWith('anchor')))
  console.log(`mean fit: anchors ${aMean.toFixed(3)} vs real ${rMean.toFixed(3)}`)
  assert(aMean > rMean, 'on-brand anchors must out-fit unrelated real posts')
  const cap = new Map([...sample, ...anchors].map((p) => [p.code!, p.caption ?? '']))
  console.log('\n fit   topic            format          hook              caption')
  for (const s of all.sort((a, b) => b.fit - a.fit)) {
    console.log(`${s.fit.toFixed(3)}  ${s.topic.padEnd(15)}  ${s.format.padEnd(14)}  ${s.hook.padEnd(16)}  ${cap.get(s.code)!.replace(/\s+/g, ' ').slice(0, 50)}`)
  }
  console.log(`\nposts ${all.length}  calls ${usage.calls}  tokens ${usage.inputTokens}  $${usage.usd.toFixed(5)}  wall ${usage.ms}ms`)
  const again = await scorePosts(anchors)
  assert(again.usage.cached === anchors.length && again.usage.calls === 0, 'second run served from cache')
}
type PostScore = import('./jev').PostScore

async function main() {
  testFitScore(); testRankScore(); testPostState()
  console.log('pure tests passed')
  await testLive()
  console.log('jev tests passed')
}
main().catch((e) => { console.error(e); process.exit(1) })
