import { NextRequest, NextResponse } from 'next/server'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })

// GET /api/essays?token=xxx
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400 })

  const { rows } = await pool.query(
    'SELECT id, school, program, degree, en_text, zh_text, updated_at FROM essays WHERE user_token=$1 ORDER BY updated_at DESC',
    [token]
  )
  return NextResponse.json({ essays: rows })
}

// POST /api/essays → upsert by user_token + school
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { token, school, program, degree, en_text, zh_text } = body
  if (!token || !school) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

  const { rows } = await pool.query(
    `INSERT INTO essays (user_token, school, program, degree, en_text, zh_text, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (user_token, school)
     DO UPDATE SET program=$3, degree=$4, en_text=$5, zh_text=$6, updated_at=now()
     RETURNING *`,
    [token, school, program ?? null, degree ?? null, en_text ?? null, zh_text ?? null]
  )
  return NextResponse.json({ essay: rows[0] })
}

// DELETE /api/essays?token=xxx&id=yyy
export async function DELETE(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  const id = req.nextUrl.searchParams.get('id')
  if (!token || !id) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

  await pool.query('DELETE FROM essays WHERE id=$1 AND user_token=$2', [id, token])
  return NextResponse.json({ ok: true })
}
