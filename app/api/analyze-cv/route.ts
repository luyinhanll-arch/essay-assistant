import { callDeepSeek } from '@/lib/deepseek'

const SYSTEM_PROMPT = `你是一位经验丰富的留学申请顾问，擅长从申请者的简历中识别文书潜力。
你的任务是分析简历，告诉申请者访谈中会重点聊哪些经历，并将每段经历准确归入项目经历、实习经历、科研经历三类之一。

分类标准：
- 项目经历：课程项目、课程设计、毕业设计、竞赛、个人/开源项目、创业、社会实践、学生组织或社团中的实质性工作，以及非正式协助导师完成的项目
- 实习经历：企业、机构或政府部门正式录用的实习/工作岗位
- 科研经历：正式加入实验室或课题组并持续参与研究，或以作者身份发表/投稿学术论文
- 同一段经历只选择一个最主要的类型；不要输出“其他”或多个类型

输出格式要求（纯文本，不要 JSON，不要 Markdown 标题符号 #）：

【值得重点深挖的经历】
逐条列出 3-4 段最值得深聊的经历，最多不得超过 4 段。宁缺毋滥：只有明显具备文书价值、值得进行多轮追问的经历才纳入。必须先列科研经历，再列实习经历，最后列项目经历；同一类型内部按重要程度排序。每条严格按以下格式输出，不要加其他内容：

经历名称：[简短的经历名称，10字以内]
经历类型：[项目经历/实习经历/科研经历，三选一]
深挖原因：[为什么值得重点聊，有什么文书潜力或未挖掘的深度，2-3句话]`

function sortAnalysisByExperienceType(analysis: string): string {
  const entries: Array<{ name: string; type: string; reason: string }> = []
  let current: { name: string; type: string; reason: string } | null = null

  for (const raw of analysis.split('\n')) {
    const line = raw.trim()
    if (!line || line === '【值得重点深挖的经历】') continue
    if (/^经历名称[：:]/.test(line)) {
      if (current) entries.push(current)
      current = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '', reason: '' }
    } else if (/^经历类型[：:]/.test(line) && current) {
      current.type = line.replace(/^经历类型[：:]/, '').trim()
    } else if (/^深挖原因[：:]/.test(line) && current) {
      current.reason = line.replace(/^深挖原因[：:]/, '').trim()
    } else if (current && current.reason) {
      current.reason += ` ${line}`
    }
  }
  if (current) entries.push(current)
  if (entries.length === 0) return analysis

  const order: Record<string, number> = {
    科研经历: 0,
    实习经历: 1,
    项目经历: 2,
  }
  return entries
    .map((entry, originalIndex) => ({ ...entry, originalIndex }))
    .sort((a, b) => (order[a.type] ?? 99) - (order[b.type] ?? 99) || a.originalIndex - b.originalIndex)
    .slice(0, 4)
    .map(entry => [
      `经历名称：${entry.name}`,
      `经历类型：${entry.type}`,
      `深挖原因：${entry.reason}`,
    ].join('\n'))
    .join('\n\n')
}

export async function POST(req: Request) {
  const { cvText }: { cvText: string } = await req.json()
  if (!cvText?.trim()) {
    return Response.json({ error: '简历内容为空' }, { status: 400 })
  }

  try {
    const rawAnalysis = await callDeepSeek(
      SYSTEM_PROMPT,
      `以下是申请者的简历，请生成访谈提纲：\n\n${cvText.trim()}`
    )
    const analysis = sortAnalysisByExperienceType(rawAnalysis)
    return Response.json({ analysis })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
