import { callDeepSeek } from '@/lib/deepseek'
import { PERSONA_SYSTEM_PROMPT } from '@/lib/prompts'

export async function POST(req: Request) {
  const { transcript }: { transcript: string } = await req.json()

  let text: string
  try {
    text = await callDeepSeek(
      PERSONA_SYSTEM_PROMPT,
      `以下是申请者的访谈记录，请生成2-3个候选人设方向：\n\n${transcript}`
    )
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return Response.json({ error: '解析失败', raw: text }, { status: 500 })
  }

  try {
    const personas = JSON.parse(jsonMatch[0])
    return Response.json({ personas })
  } catch {
    return Response.json({ error: 'JSON解析失败', raw: text }, { status: 500 })
  }
}
