import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { NextRequest, NextResponse } from 'next/server'

const REPO_ROOT = path.resolve(process.cwd())
const SEARCHES_FILE = path.join(REPO_ROOT, 'searches.json')
const SCRIPT_PATH = path.join(REPO_ROOT, 'instagram_search.py')

export type SearchType = 'top' | 'user' | 'hashtag' | 'place'

export interface SearchRecord {
  id: string
  timestamp: string
  query: string
  search_type: SearchType
  results: SearchResult[]
}

export interface SearchResult {
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

function readHistory(): SearchRecord[] {
  try {
    if (!fs.existsSync(SEARCHES_FILE)) return []
    const raw = fs.readFileSync(SEARCHES_FILE, 'utf-8')
    return JSON.parse(raw) as SearchRecord[]
  } catch {
    return []
  }
}

function appendRecord(record: SearchRecord): void {
  const history = readHistory()
  history.unshift(record) // newest first
  fs.writeFileSync(SEARCHES_FILE, JSON.stringify(history, null, 2), 'utf-8')
}

function runPythonSearch(query: string, searchType: SearchType): Promise<SearchRecord> {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT_PATH, query, '--type', searchType]
    const proc = spawn('python3', args, { cwd: REPO_ROOT })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('close', (code) => {
      if (code !== 0) {
        // Surface the Python error clearly.
        return reject(new Error(stderr || `instagram_search.py exited with code ${code}`))
      }
      try {
        // The script may emit log lines to stdout before the JSON object.
        // Find the first '{' to locate the JSON payload.
        const jsonStart = stdout.indexOf('{')
        if (jsonStart === -1) throw new Error('No JSON found in script output')
        const parsed = JSON.parse(stdout.slice(jsonStart))
        const record: SearchRecord = {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          query: parsed.query ?? query,
          search_type: (parsed.search_type ?? searchType) as SearchType,
          results: parsed.results ?? [],
        }
        resolve(record)
      } catch (err) {
        reject(new Error(`Failed to parse script output: ${err}`))
      }
    })

    proc.on('error', (err) => reject(err))
  })
}

export async function POST(req: NextRequest) {
  let body: { query?: string; search_type?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const query = (body.query ?? '').trim()
  if (!query) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  const validTypes: SearchType[] = ['top', 'user', 'hashtag', 'place']
  const searchType: SearchType = validTypes.includes(body.search_type as SearchType)
    ? (body.search_type as SearchType)
    : 'top'

  try {
    const record = await runPythonSearch(query, searchType)
    appendRecord(record)
    return NextResponse.json(record)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
