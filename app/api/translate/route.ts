import { callDeepSeek } from '@/lib/deepseek'
import { TRANSLATE_SYSTEM_PROMPT, TRANSLATE_ZH_TO_EN_PROMPT } from '@/lib/prompts'

export async function POST(req: Request) {
  const { text, direction = 'en-zh' }: { text: string; direction?: string } = await req.json()

  const systemPrompt = direction === 'zh-en' ? TRANSLATE_ZH_TO_EN_PROMPT : TRANSLATE_SYSTEM_PROMPT

  let translation: string
  try {
    translation = await callDeepSeek(systemPrompt, text)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  return Response.json({ translation })
}
