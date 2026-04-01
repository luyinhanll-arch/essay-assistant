import { callDeepSeek } from '@/lib/deepseek'

const SYSTEM_PROMPT = `你是一位经验丰富的留学申请顾问，擅长从申请者的简历中识别文书潜力。
你的任务是分析简历，告诉申请者访谈中会重点聊哪些经历。

输出格式要求（纯文本，不要 JSON，不要 Markdown 标题符号 #）：

【值得重点深挖的经历】
逐条列出 3-5 段最值得深聊的经历（按重要程度排序）。每条严格按以下格式输出，不要加其他内容：

经历名称：[简短的经历名称，10字以内]
深挖原因：[为什么值得重点聊，有什么文书潜力或未挖掘的深度，2-3句话]`

export async function POST(req: Request) {
  const { cvText }: { cvText: string } = await req.json()
  if (!cvText?.trim()) {
    return Response.json({ error: '简历内容为空' }, { status: 400 })
  }

  try {
    const analysis = await callDeepSeek(
      SYSTEM_PROMPT,
      `以下是申请者的简历，请生成访谈提纲：\n\n${cvText.trim()}`
    )
    return Response.json({ analysis })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
