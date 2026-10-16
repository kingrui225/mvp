import { countBy, engagementRate, extractHashtags, fitTone, humanLabel, sortPosts, SORT_LABELS, topAlternatives, withinDays } from './post-metrics'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}
const eq = (a: unknown, b: unknown, m: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${m}: got ${JSON.stringify(a)}`)

function testHashtags() {
  eq(extractHashtags('Hi #Study #study #Café_1 #日本語 text'), ['study', 'café_1', '日本語'], 'dedupe/lowercase/unicode')
  eq(extractHashtags('no tags here'), [], 'none')
  eq(extractHashtags(undefined), [], 'undefined')
}

function testEngagement() {
  assert(engagementRate({}) === null, 'missing views -> null')
  assert(engagementRate({ view_count: 0, like_count: 5 }) === null, 'zero views -> null')
  assert(engagementRate({ view_count: 100, like_count: 3, comment_count: 1 }) === 0.04, '(3+1)/100')
  assert(engagementRate({ view_count: 100 }) === 0, 'missing likes/comments = 0')
}

function testWithinDays() {
  const now = Date.parse('2026-01-10T00:00:00Z')
  assert(withinDays({}, null, now), 'null days keeps all')
  assert(!withinDays({}, 7, now), 'no taken_at excluded when filtering')
  assert(withinDays({ taken_at: '2026-01-05T00:00:00Z' }, 7, now), '5d old within 7d')
  assert(!withinDays({ taken_at: '2025-12-01T00:00:00Z' }, 7, now), '40d old outside 7d')
}

function testSorts() {
  const ps = [
    { id: 'a', view_count: 100, like_count: 5, comment_count: 0, taken_at: '2026-01-01T00:00:00Z' },
    { id: 'b' },
    { id: 'c', view_count: 1000, like_count: 10, comment_count: 0, taken_at: '2026-01-03T00:00:00Z' },
    { id: 'd', view_count: 100, like_count: 50, comment_count: 0 },
    { id: 'e', view_count: 100, like_count: 5, comment_count: 0, taken_at: '2026-01-02T00:00:00Z' },
  ]
  const ids = (k: Parameters<typeof sortPosts>[1]) => sortPosts(ps, k).map((p) => p.id).join('')
  assert(ids('relevance') === 'abcde', 'relevance keeps order')
  assert(sortPosts(ps, 'relevance') !== ps, 'returns new array')
  eq(ids('newest'), 'ceabd', 'newest, missing last (stable b,d)')
  eq(ids('views'), 'cadeb', 'views desc, ties stable, missing last')
  eq(ids('likes'), 'dcaeb', 'likes desc, ties stable, missing last')
  eq(ids('engagement'), 'daecb', 'engagement desc, missing last')
  assert(Object.keys(SORT_LABELS).length === 6, 'label per key')
}

function testFit() {
  const ps: { id: string; s: number | null; caption?: string }[] = [{ id: 'a', s: 0.2 }, { id: 'b', s: null }, { id: 'c', s: 0.9 }, { id: 'd', s: 0.5 }]
  eq(sortPosts(ps, 'fit', (p) => p.s).map((p) => p.id), ['c', 'd', 'a', 'b'], 'fit desc, unscored last')
  eq(sortPosts(ps, 'fit').map((p) => p.id), ['a', 'b', 'c', 'd'], 'fit without valueOf keeps order')
  eq([humanLabel('sports_gameday'), humanLabel('pov'), humanLabel('campus_life')], ['Sports / gameday', 'POV', 'Campus life'], 'labels')
  eq([fitTone(0.6), fitTone(0.59), fitTone(0.35), fitTone(0.34)], ['high', 'mid', 'mid', 'low'], 'tones')
  eq(countBy([{ t: 'x' }, { t: 'y' }, { t: 'y' }, {}], (p: { t?: string }) => p.t), [['y', 2], ['x', 1]], 'countBy')
  eq(topAlternatives({ probabilities: { a: 0.1, b: 0.6, c: 0.3, d: 0.0 } }, 2), [['b', 0.6], ['c', 0.3]], 'alts object')
  eq(topAlternatives({ probabilities: [{ choice: 'a', probability: 0.2 }, { choice: 'b', probability: 0.8 }] }), [['b', 0.8], ['a', 0.2]], 'alts array')
  eq(topAlternatives(undefined), [], 'alts none')
}

testHashtags()
testEngagement()
testWithinDays()
testSorts()
testFit()
console.log('post-metrics tests passed')
