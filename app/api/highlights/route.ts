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
  const { summaries, existingPersonas = [] }: {
    summaries: Record<string, string>
    existingPersonas?: { id: string; title: string }[]
  } = await req.json()

  const summaryText = Object.entries(summaries)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `【${DIM_LABELS[k] ?? k}】\n${v.trim()}`)
    .join('\n\n')

  const regenerateBlock = existingPersonas.length > 0
    ? `\n\n⚠️ 上一次已生成了以下方向：${existingPersonas.map(p => `"${p.title}"`).join('、')}。请生成与这些方向**明显不同**的新叙事角度，不得重复相同标题或相同核心叙事逻辑。`
    : ''

  let text: string
  try {
    text = await callDeepSeek(
      PERSONA_SYSTEM_PROMPT,
      `以下是申请者各维度的经历总结，请生成2-3个候选人设方向：\n\n${summaryText}${regenerateBlock}`
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
