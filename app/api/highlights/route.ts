import { callDeepSeek } from '@/lib/deepseek'
import { PERSONA_SYSTEM_PROMPT } from '@/lib/prompts'

const DIM_LABELS: Record<string, string> = {
  academic:   '学术背景',
  project:    '项目经历',
  internship: '实习经历',
  research:   '科研经历',
  motivation: '申请动机',
  plan:       '未来规划',
  personal:   '个人特质',
}

export async function POST(req: Request) {
  const { summaries }: { summaries: Record<string, string> } = await req.json()

  const summaryText = Object.entries(summaries)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `【${DIM_LABELS[k] ?? k}】\n${v.trim()}`)
    .join('\n\n')

  let text: string
  try {
    text = await callDeepSeek(
      PERSONA_SYSTEM_PROMPT,
      `以下是申请者各维度的经历总结，请生成2-3个候选人设方向：\n\n${summaryText}`
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
