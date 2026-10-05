/**
 * One-time, idempotent import of local searches.json / session.json.
 *
 * Usage:
 *   MIGRATE_USER_ID=<uuid> pnpm exec tsx scripts/migrate-local-to-supabase.ts
 *
 * Rules:
 *  - Insert only. Never update or delete existing rows.
 *  - Duplicate local IDs are ignored via ON CONFLICT / unique keys.
 */
import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '../lib/encrypt'

const ROOT = path.resolve(process.cwd())
const SEARCHES = path.join(ROOT, 'searches.json')
const SESSION = path.join(ROOT, 'session.json')

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const userId = required('MIGRATE_USER_ID')
  const supabase = createClient(
    required('NEXT_PUBLIC_SUPABASE_URL'),
    required('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  await supabase.from('profiles').insert({ id: userId }).then(() => undefined)

  if (existsSync(SEARCHES)) {
    const records = JSON.parse(readFileSync(SEARCHES, 'utf8')) as Array<{
      id?: string
      timestamp?: string
      query: string
      search_type: string
      limit?: number
      results?: Array<Record<string, unknown>>
    }>

    for (const record of records) {
      const searchId = /^[0-9a-f-]{36}$/i.test(record.id ?? '') ? record.id! : randomUUID()
      const createdAt = record.timestamp ?? new Date().toISOString()
      const { error } = await supabase.from('search_events').insert({
        id: searchId,
        user_id: userId,
        query: record.query,
        search_type: record.search_type,
        result_limit: record.limit ?? (record.results?.length ?? 0),
        result_count: record.results?.length ?? 0,
        created_at: createdAt,
      })
      if (error && error.code !== '23505') {
        throw new Error(`search_events insert failed: ${error.message}`)
      }

      const results = record.results ?? []
      if (results.length === 0) continue
      const { error: resultError } = await supabase.from('search_result_events').insert(
        results.map((r) => ({
          search_event_id: searchId,
          user_id: userId,
          pk: r.pk ?? null,
          code: r.code ?? null,
          url: r.url ?? null,
          media_type: r.media_type ?? null,
          thumbnail_url: r.thumbnail_url ?? null,
          video_url: r.video_url ?? null,
          caption: r.caption ?? null,
          like_count: r.like_count ?? null,
          comment_count: r.comment_count ?? null,
          view_count: r.view_count ?? null,
          taken_at: r.taken_at ?? null,
          ig_username: r.username ?? null,
          user_pk: r.user_pk ?? null,
          is_verified: r.is_verified ?? null,
          created_at: createdAt,
        })),
      )
      if (resultError && resultError.code !== '23505') {
        throw new Error(`search_result_events insert failed: ${resultError.message}`)
      }
    }
    console.log(`Imported ${records.length} search records (duplicates ignored).`)
  }

  if (existsSync(SESSION)) {
    const raw = readFileSync(SESSION, 'utf8')
    const parsed = JSON.parse(raw) as {
      username?: string
      instagrapi_settings?: { authorization_data?: { ds_user_id?: string } }
    }
    const igUserId = parsed.instagrapi_settings?.authorization_data?.ds_user_id ?? null
    const { data: account } = await supabase
      .from('instagram_accounts')
      .insert({
        user_id: userId,
        ig_user_id: igUserId,
        ig_username: parsed.username ?? null,
        status: 'active',
      })
      .select('id')
      .single()

    if (account) {
      const digest = createHash('sha256').update(raw).digest('hex')
      await supabase.from('instagram_session_events').insert({
        id: randomUUID(),
        user_id: userId,
        ig_account_id: account.id,
        session_blob: encrypt(raw),
      })
      console.log(`Imported local Instagram session snapshot ${digest.slice(0, 12)}.`)
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
