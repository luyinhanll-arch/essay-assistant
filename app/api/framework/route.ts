import { callDeepSeek } from '@/lib/deepseek'
import { SOP_FRAMEWORK_SYSTEM_PROMPT, PS_FRAMEWORK_SYSTEM_PROMPT } from '@/lib/prompts'
import type { Persona, EssayType } from '@/lib/types'

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
  const {
    summaries,
    persona,
    targetProgram,
    essayType,
    schoolNotes,
  }: {
    summaries: Record<string, string>
    persona: Persona | null
    targetProgram: string
    essayType: EssayType
    schoolNotes: string
  } = await req.json()

  // Parse targetProgram: "UCLA/USC | Computer Science | MS"
  const programParts = targetProgram.split('|').map((s) => s.trim())
  const schools = programParts[0] || '（未指定）'
  const major = programParts[1] || '（未指定）'
  const degree = programParts[2] || '（未指定）'

  const summaryText = Object.entries(summaries)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `【${DIM_LABELS[k] ?? k}】\n${v.trim()}`)
    .join('\n\n')

  const personaText = persona
    ? `人设标签：${persona.title}
叙事定位：${persona.tagline}
人设描述：${persona.description}
支撑经历：${persona.evidence}
文书侧重：${persona.focus}`
    : '（未选择人设方向，请根据经历总结自行提炼核心角度）'

  const schoolNotesText = schoolNotes.trim()
    ? `\n## 学校/项目特殊要求或偏好\n${schoolNotes.trim()}`
    : ''

  const userPrompt = `## 文书类型
${essayType}

## 目标申请项目
院校：${schools}
专业：${major}
学位：${degree}

## 申请者选定的人设方向
${personaText}
${schoolNotesText}

## 申请者各维度经历总结
${summaryText}

请严格围绕选定的人设方向构建文书框架，让每个段落都服务于这个叙事角度。suggestedContent 必须直接引用申请者的具体经历，不要写通用建议。`

  const systemPrompt = essayType === 'PS' ? PS_FRAMEWORK_SYSTEM_PROMPT : SOP_FRAMEWORK_SYSTEM_PROMPT

  let text: string
  try {
    text = await callDeepSeek(systemPrompt, userPrompt)
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) {
    return Response.json({ error: '解析失败', raw: text }, { status: 500 })
  }

  try {
    const framework = JSON.parse(jsonMatch[0])
    return Response.json({ framework })
  } catch {
    return Response.json({ error: 'JSON解析失败', raw: text }, { status: 500 })
  }
}
