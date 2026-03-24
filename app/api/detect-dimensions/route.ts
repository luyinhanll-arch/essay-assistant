import { callDeepSeek } from '@/lib/deepseek'
import type { Message } from '@/lib/types'

const ALL_DIMS = ['academic', 'research', 'internship', 'project', 'motivation', 'plan', 'personal'] as const
type DimKey = typeof ALL_DIMS[number]

const DIM_LABELS: Record<DimKey, string> = {
  academic:   '学术背景',
  research:   '科研经历',
  internship: '实习经历',
  project:    '项目经历',
  motivation: '申请动机',
  plan:       '未来规划',
  personal:   '个人特质',
}

// 每个维度的问题关键词（用于在没有 [ASKING] 标记时兜底定位）
// research / motivation / plan / personal 使用较弱的关键词兜底，
// 但匹配时会额外要求消息包含问号（？/?)，防止在其他话题顺带提及时误触发。
const DIM_QUESTION_PATTERNS: Record<DimKey, string[]> = {
  academic:   ['本科.*学校', '学的什么专业', 'gpa|成绩|绩点|排名', '毕业论文|毕设', '学术表现|学习情况'],
  research:   ['有没有.*科研', '帮.*老师.*课题', '加入过.*实验室', '参与过.*研究', '做过.*科研'],
  internship: ['有没有.*实习', '做过.*实习.*吗', '实习.*经历.*吗', '做过.*兼职', 'ta|助教.*经历'],
  project:    ['项目经历', '做过.*项目', '有.*项目', '聊聊.*项目', '课程.*项目|课程作业', '参加过.*比赛|竞赛', '个人项目|课外项目'],
  motivation: ['什么时候.*感兴趣', '为什么.*申请|为什么想.*出来', '是什么.*让你决定', '申请.*这个.*专业|选择.*这个.*方向'],
  plan:       ['毕业.*之后.*想|毕业后.*想', '未来.*想做|未来.*打算', '职业.*方向|职业.*目标', '有没有想过.*规划'],
  personal:   ['印象深刻', '成长了很多|让你成长', '改变了.*想法', '你有.*什么.*特点|发现你.*特点'],
}

// research/motivation/plan/personal 使用"弱"关键词，匹配时须附加问号检测
const QUESTION_MARK_REQUIRED_DIMS = new Set<DimKey>(['research', 'motivation', 'plan', 'personal'])

/**
 * 第一步：直接从对话中解析已有的 [COVERED]、[EMPTY]、[ASKING] 标记
 * 这是最可靠的信号，优先级最高
 */
function parseTagsFromConversation(messages: Message[]) {
  const covered: string[] = []
  const empty: string[]   = []
  const asked: string[]   = []

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const c = msg.content

    // [COVERED:dim1,dim2]
    const covMatch = c.match(/\[COVERED[：:]\s*([^\]]+)\]/gi)
    if (covMatch) {
      covMatch.forEach(m => {
        const inner = m.replace(/\[COVERED[：:]\s*/i, '').replace(']', '')
        inner.split(',').map(s => s.trim()).filter(Boolean).forEach(d => {
          if (!covered.includes(d)) covered.push(d)
        })
      })
    }

    // [EMPTY:dim]
    const emMatch = c.match(/\[EMPTY[：:]\s*([^\]]+)\]/gi)
    if (emMatch) {
      emMatch.forEach(m => {
        const inner = m.replace(/\[EMPTY[：:]\s*/i, '').replace(']', '')
        inner.split(',').map(s => s.trim()).filter(Boolean).forEach(d => {
          if (!empty.includes(d)) empty.push(d)
        })
      })
    }

    // [ASKING:dim]
    const askMatch = c.match(/\[ASKING[：:]\s*([^\]]+)\]/gi)
    if (askMatch) {
      askMatch.forEach(m => {
        const inner = m.replace(/\[ASKING[：:]\s*/i, '').replace(']', '').trim()
        if (!asked.includes(inner)) asked.push(inner)
      })
    }
  }

  return { covered, empty, asked }
}

/**
 * 第二步：提取某维度的"问答窗口"
 * 从 [ASKING:dim] 标记所在位置起，到下一个 [ASKING:其他dim] 前结束
 * 收集这段范围内顾问的问题和用户的所有回答
 */
function extractDimWindow(
  messages: Message[],
  dimKey: string
): { questions: string[]; answers: string[] } | null {
  let startIdx = -1

  // 优先用 [ASKING:dim] 标记定位
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'assistant' &&
        new RegExp(`\\[ASKING[：:]\\s*${dimKey}\\]`, 'i').test(msg.content)) {
      startIdx = i
      break
    }
  }

  // 没有 ASKING 标记时，用问题关键词兜底
  if (startIdx === -1) {
    const patterns = DIM_QUESTION_PATTERNS[dimKey as DimKey] || []
    const needsQ = QUESTION_MARK_REQUIRED_DIMS.has(dimKey as DimKey)
    outer: for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'assistant') {
        const c = messages[i].content
        if (needsQ && !/[？?]/.test(c)) continue
        for (const p of patterns) {
          if (new RegExp(p, 'i').test(c)) {
            startIdx = i
            break outer
          }
        }
      }
    }
  }

  if (startIdx === -1) return null

  // 找到下一个"切换到其他维度"的 ASKING 标记作为窗口终点
  let endIdx = messages.length
  for (let i = startIdx + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      const askMatch = messages[i].content.match(/\[ASKING[：:]\s*([^\]]+)\]/i)
      if (askMatch) {
        const nextDim = askMatch[1].trim()
        if (nextDim !== dimKey) {
          endIdx = i
          break
        }
      }
    }
  }

  const window = messages.slice(startIdx, endIdx)
  const questions = window
    .filter(m => m.role === 'assistant')
    .map(m => m.content.replace(/\[[^\]]+\]/g, '').trim())
    .filter(Boolean)
  const answers = window
    .filter(m => m.role === 'user')
    .map(m => m.content.trim())
    .filter(Boolean)

  return { questions, answers }
}

/**
 * 第三步：用 AI 分析"有问有答"但尚未打标记的维度窗口
 * 针对每个维度的问答内容做定向判断，不做全局扫描
 */
async function analyzeWindowsWithAI(
  windows: Partial<Record<DimKey, { questions: string[]; answers: string[] }>>
): Promise<Partial<Record<DimKey, { covered: boolean; empty: boolean; confidence: number; evidence: string }>>> {
  const dimKeys = Object.keys(windows) as DimKey[]
  if (dimKeys.length === 0) return {}

  // 构建每个维度的问答摘要
  const sections = dimKeys.map(dim => {
    const { questions, answers } = windows[dim]!
    const qText = questions.slice(0, 4).join('\n顾问继续问：')
    const aText = answers.join('\n用户继续说：')
    return `【${DIM_LABELS[dim]}（${dim}）】\n顾问问：${qText}\n用户回答：${aText}`
  }).join('\n\n---\n\n')

  const systemPrompt = `你是留学申请访谈分析专家，专门判断申请者是否已提供某维度的信息。`

  const userPrompt = `以下是顾问针对各维度的提问，以及用户的具体回答。请逐一分析每个维度。

${sections}

## 判断规则（必须严格遵守）：
- **covered=true**：用户给出了任何实质性回应，包括描述了经历、给出了方向，甚至说"没有"也算
- **empty=true**：用户明确表示没有该类经历（如"没有实习"、"没有科研"、"没做过"）
  - empty=true 时，covered 也应为 true（"没有"是一种明确信息）
- **covered=false**：用户完全没有回应顾问的问题，或回答与该维度完全无关
- 对于"未来规划"维度：只要用户说了任何方向（包括"不确定"、"还没想好"），covered=true
- 对于"申请动机"维度：只要用户表达了任何理由或感受，covered=true
- confidence 反映回答的具体程度：0.9=非常详细具体；0.7=有实质内容；0.5=较简短但有效；0.3=含糊或敷衍

## 输出格式（严格 JSON，不要其他文字）：
{
  "results": [
    {
      "dim": "research",
      "covered": true,
      "empty": false,
      "confidence": 0.85,
      "evidence": "用户说做过XX课题，在YY实验室"
    }
  ]
}`

  try {
    const raw = await callDeepSeek(systemPrompt, userPrompt)

    // 提取 JSON
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (!jsonMatch) throw new Error('no json')
    const parsed = JSON.parse(jsonMatch[0])

    const out: Partial<Record<DimKey, { covered: boolean; empty: boolean; confidence: number; evidence: string }>> = {}
    if (Array.isArray(parsed.results)) {
      for (const r of parsed.results) {
        if (r.dim && ALL_DIMS.includes(r.dim)) {
          out[r.dim as DimKey] = {
            covered:    Boolean(r.covered),
            empty:      Boolean(r.empty),
            confidence: Math.min(Math.max(Number(r.confidence) || 0.5, 0.1), 0.95),
            evidence:   String(r.evidence || ''),
          }
        }
      }
    }
    return out
  } catch (e) {
    console.error('[detect-dimensions] AI窗口分析失败:', e)
    // 失败时：只要有答案就认为 covered（保守兜底）
    const fallback: Partial<Record<DimKey, { covered: boolean; empty: boolean; confidence: number; evidence: string }>> = {}
    for (const dim of dimKeys) {
      const answers = windows[dim]?.answers || []
      const hasAnswer = answers.some(a => a.length > 10)
      fallback[dim] = {
        covered:    hasAnswer,
        empty:      false,
        confidence: hasAnswer ? 0.65 : 0.2,
        evidence:   hasAnswer ? '有回答但AI分析失败' : '无有效回答',
      }
    }
    return fallback
  }
}

export async function POST(req: Request) {
  try {
    const { messages, alreadyCovered = [] }: { messages: Message[]; alreadyCovered?: string[] } = await req.json()

    if (!messages || !Array.isArray(messages)) {
      return Response.json({ error: '缺少必要参数' }, { status: 400 })
    }

    // ── 第一步：解析对话中已有的标记（最可靠） ──────────────────────────────
    const tagData = parseTagsFromConversation(messages)

    // 合并客户端传来的已覆盖维度 + 对话标记中发现的
    const allCovered = Array.from(new Set([...alreadyCovered, ...tagData.covered]))
    const allEmpty   = Array.from(new Set([...tagData.empty]))

    // ── 第二步：找出"已问到但还没标记"的维度，提取其问答窗口 ────────────────
    // 已问到 = ASKING 标记存在，或能用关键词匹配到顾问的提问
    const askedDims = new Set<string>(tagData.asked)

    // 补充：用关键词兜底找其他被问到但没有 ASKING 标记的维度
    for (const dim of ALL_DIMS) {
      if (askedDims.has(dim)) continue
      const patterns = DIM_QUESTION_PATTERNS[dim]
      const needsQ = QUESTION_MARK_REQUIRED_DIMS.has(dim)
      for (const msg of messages) {
        if (msg.role !== 'assistant') continue
        if (needsQ && !/[？?]/.test(msg.content)) continue
        for (const p of patterns) {
          if (new RegExp(p, 'i').test(msg.content)) {
            askedDims.add(dim)
            break
          }
        }
        if (askedDims.has(dim)) break
      }
    }

    // 需要 AI 分析的维度 = 已问到 + 未被标记为 covered/empty
    const needAnalysis = ALL_DIMS.filter(d =>
      askedDims.has(d) &&
      !allCovered.includes(d) &&
      !allEmpty.includes(d)
    )

    const windows: Partial<Record<DimKey, { questions: string[]; answers: string[] }>> = {}
    for (const dim of needAnalysis) {
      const w = extractDimWindow(messages, dim)
      // 只有用户有过回答的窗口才送 AI 分析
      if (w && w.answers.length > 0) {
        windows[dim as DimKey] = w
      }
    }

    // ── 第三步：AI 分析问答窗口 ─────────────────────────────────────────────
    const aiResults = await analyzeWindowsWithAI(windows)

    // ── 第四步：汇总最终结果 ─────────────────────────────────────────────────
    const dimensions = ALL_DIMS.map(dim => {
      const fromTag     = allCovered.includes(dim)
      const fromEmpty   = allEmpty.includes(dim)
      const ai          = aiResults[dim as DimKey]

      // 已有标记 → 直接用标记结果（最高优先级）
      if (fromTag) {
        return {
          key: dim, label: DIM_LABELS[dim as DimKey],
          covered: true, empty: false,
          confidence: 0.95, evidence: '对话中 [COVERED] 标记', summary: '',
        }
      }
      if (fromEmpty) {
        return {
          key: dim, label: DIM_LABELS[dim as DimKey],
          covered: true, empty: true,
          confidence: 0.95, evidence: '对话中 [EMPTY] 标记', summary: '',
        }
      }

      // AI 分析结果
      if (ai) {
        return {
          key: dim, label: DIM_LABELS[dim as DimKey],
          covered:    ai.covered,
          empty:      ai.empty,
          confidence: ai.confidence,
          evidence:   ai.evidence,
          summary:    '',
        }
      }

      // 未被问到 / 无分析结果
      return {
        key: dim, label: DIM_LABELS[dim as DimKey],
        covered: false, empty: false,
        confidence: 0.1, evidence: askedDims.has(dim) ? '已问到但用户未回答' : '尚未问到该维度', summary: '',
      }
    })

    // covered 或 empty 且置信度 >= 0.6 的维度才计入 coveredDimensions
    const coveredDimensions = dimensions
      .filter(d => d.covered && d.confidence >= 0.6)
      .map(d => d.key)

    return Response.json({ dimensions, coveredDimensions, success: true })

  } catch (error) {
    console.error('[detect-dimensions] 错误:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : '维度识别失败', success: false },
      { status: 500 }
    )
  }
}
