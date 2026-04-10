import { callDeepSeek } from '@/lib/deepseek'

const STUDENT_SYSTEM_PROMPT = `你是一个正在接受留学申请顾问采访的中国学生，名叫李晓雨。你的背景如下：

**基本信息**
- 就读：北京大学，信息管理与信息系统专业，大四
- GPA：3.6/4.0，专业排名前 20%

**学术背景**
- 核心课程：数据库原理、机器学习、数据挖掘、信息检索、商业智能
- 最投入的课：机器学习（期末做了电商用户流失预测，随机森林，准确率 87%）
- 毕设方向还没定，大概是推荐系统相关

**项目经历**
- 泰迪杯数据挖掘竞赛：三人团队，我负责特征工程和调参，用 XGBoost，全国三等奖
- 个人项目：用 Streamlit 做了豆瓣电影推荐系统（协同过滤），部署在 Heroku
- 课程大作业：电商用户流失预测

**实习经历**
- 京东数据分析部，实习 3 个月
- 主要工作：SQL 查询、Tableau 报表，分析某品类复购率下降原因
- 成果：发现某渠道新用户质量差，报告被采纳，投放策略调整

**科研经历**
- 无正式科研经历，帮老师做过两周爬虫，不算正式课题

**申请目标**
- CMU，MSML（Master of Science in Machine Learning），MS 硕士

**申请动机**
- 国内 ML 理论不够深，想系统学习；未来做推荐系统方向算法工程师

**未来规划**
- 短期进大厂做推荐算法，3-5 年后往 tech lead 方向走

**个人特质**
- 执行力强，想到就做；有时想太多会拖延但一旦开始能做完；学东西快

**回答风格（重要）**
- 轻松口语化聊天，不是写简历
- 每次只回答刚问的那个问题，不主动多说
- 用"嗯""就是""其实""还好"等口头语
- 信息分批给，等追问再补细节
- 简单问题 1-3 句，追问时 3-5 句
- 只输出回答内容，不加任何前缀`

export async function POST(req: Request) {
  const { messages, personaPrompt, quickInfo } = await req.json() as {
    messages: { role: string; content: string }[]
    personaPrompt?: string
    quickInfo?: { school: string; major: string; gpa: string; targetSchool: string; targetMajor: string; degree: string } | null
  }

  let basePrompt = personaPrompt || STUDENT_SYSTEM_PROMPT

  // If quickInfo is provided, prepend an override block so the student's answers
  // match what Omi was told about the user — preventing persona/quickInfo mismatch.
  if (quickInfo && Object.values(quickInfo).some(v => v.trim())) {
    const parts: string[] = []
    if (quickInfo.school) parts.push(`就读院校：${quickInfo.school}`)
    if (quickInfo.major) parts.push(`就读专业：${quickInfo.major}`)
    if (quickInfo.gpa) parts.push(`GPA：${quickInfo.gpa}`)
    if (quickInfo.targetSchool) parts.push(`目标院校：${quickInfo.targetSchool}`)
    if (quickInfo.targetMajor) parts.push(`申请专业：${quickInfo.targetMajor}`)
    if (quickInfo.degree) parts.push(`申请学位：${quickInfo.degree}`)
    basePrompt = `【重要覆盖】以下基本信息优先级最高，覆盖下方 persona 中的对应字段，回答时必须使用这里的信息：\n${parts.join('\n')}\n\n` + basePrompt
  }

  // Build conversation for student: swap roles (Omi=user, student=assistant)
  const history = messages.map(m => ({
    role: m.role === 'assistant' ? 'user' : 'assistant',
    content: m.content,
  }))

  const lastOmiMessage = history[history.length - 1]?.content ?? ''
  const priorHistory = history.slice(0, -1)

  try {
    const reply = await callDeepSeekWithSystem(basePrompt, priorHistory, lastOmiMessage)
    return Response.json({ reply })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }
}

async function callDeepSeekWithSystem(
  system: string,
  history: { role: string; content: string }[],
  lastMessage: string
): Promise<string> {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: lastMessage },
      ],
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`)
  }

  const data = await res.json() as { choices: { message: { content: string } }[] }
  return data.choices[0].message.content
}
