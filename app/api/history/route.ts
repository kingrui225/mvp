import fs from 'fs'
import path from 'path'
import { NextRequest, NextResponse } from 'next/server'
import type { SearchRecord } from '../search/route'

const SEARCHES_FILE = path.join(process.cwd(), 'searches.json')

function readHistory(): SearchRecord[] {
  try {
    if (!fs.existsSync(SEARCHES_FILE)) return []
    const raw = fs.readFileSync(SEARCHES_FILE, 'utf-8')
    return JSON.parse(raw) as SearchRecord[]
  } catch {
    return []
  }
}

/** GET /api/history — returns all past searches, newest first */
export async function GET(_req: NextRequest) {
  return NextResponse.json(readHistory())
}

/** DELETE /api/history/:id — removes a single record by id */
export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get('id')

  const history = readHistory()
  const next = id ? history.filter((r) => r.id !== id) : []
  fs.writeFileSync(SEARCHES_FILE, JSON.stringify(next, null, 2), 'utf-8')
  return NextResponse.json({ ok: true })
}
