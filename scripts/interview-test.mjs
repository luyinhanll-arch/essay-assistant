/**
 * Interview auto-test script — uses DeepSeek to simulate student replies.
 * Zero Claude token cost. Only uses your existing DeepSeek API key.
 *
 * Usage:
 *   node scripts/interview-test.mjs
 * Make sure the dev server is running: npm run dev
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local for DEEPSEEK_API_KEY
try {
  const envPath = resolve(process.cwd(), '.env.local')
  const lines = readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const [k, ...v] = line.split('=')
    if (k && v.length) process.env[k.trim()] = v.join('=').trim()
  }
} catch { /* .env.local not found, rely on existing env */ }

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY

if (!DEEPSEEK_KEY) {
  console.error('Error: DEEPSEEK_API_KEY not set in .env.local')
  process.exit(1)
}

// ── Student persona (passed to DeepSeek as system prompt) ───────────────────
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
- 课程大作业：电商用户流失预测（已在学术背景里提到）

**实习经历**
- 京东数据分析部，实习 3 个月
- 主要工作：写 SQL 查询、Tableau 报表，分析某品类复购率下降原因
- 成果：发现某渠道新用户质量差，报告被采纳，投放策略调整

**科研经历**
- 无正式科研经历
- 帮老师做过两周爬虫，抓数据，不算正式课题

**申请目标**
- 学校：Carnegie Mellon University（CMU）
- 项目：MSML（Master of Science in Machine Learning）
- 学位：MS 硕士

**申请动机**
- 国内 ML 理论课不够深，想系统学习
- CMU MSML 课程设置很对口
- 未来想做推荐系统方向的算法工程师

**未来规划**
- 短期：进阿里/字节做推荐算法
- 长期：3-5 年后往 tech lead 方向发展

**个人特质**
- 执行力强，想到就做（推荐系统项目周末两天搭出来的）
- 有时想太多会拖延，但一旦开始能做完
- 学东西比较快

**回答风格要求（非常重要）**
- 你是在和顾问进行轻松的一对一聊天，不是在写简历
- 每次只回答对方刚问的那个问题，不要主动多说
- 口语化，用"嗯""就是""其实""还好"等口头语
- 信息要真实但不要一次说完，等追问再补充细节
- 简单问题回答 1-3 句，追问时 3-5 句
- 不要用列表或标题，就是自然说话
- 只输出你的回答内容，不要加任何前缀（不要说"我回答："之类的）`

async function callDeepSeek(conversationHistory, newQuestion) {
  const messages = [
    ...conversationHistory,
    { role: 'user', content: newQuestion },
  ]

  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'system', content: STUDENT_SYSTEM_PROMPT }, ...messages],
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message || `HTTP ${res.status}`)
  }

  const data = await res.json()
  return data.choices[0].message.content
}

function parseTagsFromText(text) {
  const covered  = [...text.matchAll(/\[COVERED[：:]\s*([^\]]+)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim()))
  const empty    = [...text.matchAll(/\[EMPTY[：:]\s*([^\]]+)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim()))
  const deferred = [...text.matchAll(/\[DEFERRED[：:]\s*([^\]]+)\]/g)].flatMap(m => m[1].split(',').map(s => s.trim()))
  const complete = text.includes('[INTERVIEW_COMPLETE]')
  const clean = text
    .replace(/\[COVERED[：:][^\]]*\]/g, '')
    .replace(/\[EMPTY[：:][^\]]*\]/g, '')
    .replace(/\[DEFERRED[：:][^\]]*\]/g, '')
    .replace(/\[ASKING[：:][^\]]*\]/g, '')
    .replace(/\[EXP[：:][^\]]*\]/g, '')
    .replace(/\[TARGET[：:][^\]]*\]/g, '')
    .replace(/\[INTERVIEW_COMPLETE\]/g, '')
    .trim()
  return { covered, empty, deferred, complete, clean }
}

async function readStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let full = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    full += decoder.decode(value, { stream: true })
  }
  return full
}

async function main() {
  // State for /api/interview
  const messages = []
  const coveredDimensions = []
  const deferredDimensions = []
  const emptyDimensions = []

  // Separate history for DeepSeek student (clean messages only, no tags)
  const studentHistory = []

  let round = 0

  console.log('=== Interview Auto-Test (DeepSeek student) ===\n')

  while (true) {
    round++

    // ── Call Omi ──────────────────────────────────────────────────────────
    process.stdout.write(`[轮次 ${round}]\nOmi: `)

    const res = await fetch(`${BASE_URL}/api/interview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        coveredDimensions,
        deferredDimensions,
        emptyDimensions,
        cvText: '',
        cvAnalysis: '',
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('\nAPI error:', err)
      break
    }

    const fullText = await readStream(res)
    const { covered, empty, deferred, complete, clean } = parseTagsFromText(fullText)

    console.log(clean)

    // Update interview state
    covered.forEach(d => { if (!coveredDimensions.includes(d)) coveredDimensions.push(d) })
    empty.forEach(d => {
      if (!emptyDimensions.includes(d)) emptyDimensions.push(d)
      if (!coveredDimensions.includes(d)) coveredDimensions.push(d)
    })
    deferred.forEach(d => { if (!deferredDimensions.includes(d)) deferredDimensions.push(d) })

    if (covered.length || empty.length || deferred.length) {
      console.log(`  → covered:[${covered}] empty:[${empty}] deferred:[${deferred}]`)
    }

    messages.push({ role: 'assistant', content: clean })
    studentHistory.push({ role: 'assistant', content: clean })

    if (complete) {
      console.log('\n=== 采访结束 ===')
      break
    }

    if (round > 60) {
      console.log('\n=== 超过 60 轮，强制停止 ===')
      break
    }

    // ── Generate student reply via DeepSeek ───────────────────────────────
    process.stdout.write('学生: ')
    const reply = await callDeepSeek(studentHistory, clean)
    console.log(reply)
    console.log()

    messages.push({ role: 'user', content: reply })
    studentHistory.push({ role: 'user', content: reply })
  }

  console.log('\n=== 测试结果 ===')
  console.log('覆盖维度:', coveredDimensions)
  console.log('空维度:  ', emptyDimensions)
  console.log('暂缓维度:', deferredDimensions)
  console.log('总轮次:  ', round)
}

main().catch(console.error)
