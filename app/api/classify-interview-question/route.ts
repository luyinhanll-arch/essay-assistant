import { callDeepSeek } from '@/lib/deepseek'
import { classifyInterviewQuestion, INTERVIEW_DIMENSION_ORDER } from '@/lib/interview-progress'

const VALID = new Set<string>(INTERVIEW_DIMENSION_ORDER)

export async function POST(req: Request) {
  let question = ''
  let currentDimension = ''
  let plannedDimension = ''
  try {
    const body = await req.json()
    question = String(body?.question || '')
    currentDimension = String(body?.currentDimension || '')
    plannedDimension = String(body?.plannedDimension || '')
    if (!question.trim()) return Response.json({ dimension: null, confidence: 0, evidence: '' })

    const prompt = `你是留学访谈的维度分类器，只判断助理这一轮实际提出的核心问题，不评价回答质量，也不决定采访流程。

维度定义：
- academic：学校、专业、成绩、课程内容、课程带来的知识/方法/能力
- research：正式实验室、课题组、论文或科研课题
- internship：企业/机构正式实习岗位
- project：课程大作业/设计/论文、竞赛、模拟法庭、法律援助、个人项目、社团/志愿/社会实践
- motivation：为什么申请专业、学校、地区或继续深造
- plan：毕业后的职业、读博及长期规划

判断规则：
1. 结合整条回复判断“话题引入 + 最终追问”，不能只看最后一句。例如先说“接下来聊模拟法庭竞赛”，再问“你负责什么角色”，属于 project。
2. 总结旧经历后明确引入新话题，以新话题为准。
3. 如果只是“你具体做了什么/遇到什么困难”且没有明确载体，结合当前维度判断。
4. 没有采访维度问题（寒暄、结束语）返回 null。

当前维度：${currentDimension || '无'}
服务器计划维度：${plannedDimension || '无'}
助理回复：
${question}

只输出严格 JSON，不要代码块：
{"dimension":"academic|research|internship|project|motivation|plan|null","confidence":0到1,"evidence":"不超过40字的判断依据"}`

    const raw = await callDeepSeek('你只输出合法 JSON。', prompt)
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()) as {
      dimension?: string | null
      confidence?: number
      evidence?: string
    }
    const dimension = parsed.dimension && VALID.has(parsed.dimension) ? parsed.dimension : null
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    return Response.json({ dimension, confidence, evidence: String(parsed.evidence || '').slice(0, 80) })
  } catch {
    const fallback = classifyInterviewQuestion(question)
    return Response.json({
      dimension: fallback,
      confidence: fallback ? 0.72 : 0,
      evidence: fallback ? '语义分类服务失败，使用明确意图兜底' : '',
    })
  }
}
