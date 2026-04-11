import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

// GET /api/essays?token=xxx
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400 })

  const { data, error } = await supabase
    .from('essays')
    .select('id, school, program, degree, essay_type, en_text, zh_text, updated_at')
    .eq('user_token', token)
    .order('updated_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ essays: data })
}

// POST /api/essays → upsert by user_token + school + essay_type
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { token, school, program, degree, essay_type, en_text, zh_text } = body
  if (!token || !school) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

  const type = essay_type || 'SOP'

  const { data, error } = await supabase
    .from('essays')
    .upsert(
      {
        user_token: token,
        school,
        program: program ?? null,
        degree: degree ?? null,
        essay_type: type,
        en_text: en_text ?? null,
        zh_text: zh_text ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_token,school,essay_type' }
    )
    .select()
    .single()

  if (error) {
    console.error('[essays POST] Supabase error:', error)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ essay: data })
}

// DELETE /api/essays?token=xxx&id=yyy
export async function DELETE(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token')
  const id = req.nextUrl.searchParams.get('id')
  if (!token || !id) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

  const { error } = await supabase
    .from('essays')
    .delete()
    .eq('id', id)
    .eq('user_token', token)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
