import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)

function storageUnavailable(error: unknown) {
  console.warn('[essays] storage unavailable:', error)
  return NextResponse.json(
    { error: '云端保存服务暂时无法连接，请检查 Supabase 项目状态和环境变量' },
    { status: 503 }
  )
}

function isStorageTransportError(error: { message?: string } | null) {
  return Boolean(error?.message && /fetch failed|failed to fetch|network/i.test(error.message))
}

// GET /api/essays?token=xxx
export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 400 })

    const { data, error } = await supabase
      .from('essays')
      .select('id, school, program, degree, essay_type, en_text, zh_text, updated_at')
      .eq('user_token', token)
      .order('updated_at', { ascending: false })

    if (isStorageTransportError(error)) return storageUnavailable(error)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ essays: data })
  } catch (error) {
    return storageUnavailable(error)
  }
}

// POST /api/essays → upsert by user_token + school + essay_type
export async function POST(req: NextRequest) {
  try {
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
      if (isStorageTransportError(error)) return storageUnavailable(error)
      console.warn('[essays POST] Supabase error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ essay: data })
  } catch (error) {
    return storageUnavailable(error)
  }
}

// DELETE /api/essays?token=xxx&id=yyy
export async function DELETE(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token')
    const id = req.nextUrl.searchParams.get('id')
    if (!token || !id) return NextResponse.json({ error: 'missing fields' }, { status: 400 })

    const { error } = await supabase
      .from('essays')
      .delete()
      .eq('id', id)
      .eq('user_token', token)

    if (isStorageTransportError(error)) return storageUnavailable(error)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return storageUnavailable(error)
  }
}
