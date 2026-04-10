'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { INTERVIEW_DIMENSIONS } from '@/lib/types'
import type { Message } from '@/lib/types'
import { Mascot } from '@/components/Mascot'
import {
  recoverMissedTagsFromHistory,
  findDimStartInHistory,
  findExpStartInHistory,
  detectCoverageWithAI,
  inferTargetFromMessages,
  parseAIMessage,
} from '@/lib/interview-utils'

// ── Simulation default persona ─────────────────────────────────────────────────
const DEFAULT_PERSONA = `你是一个正在接受留学申请顾问采访的中国学生，名叫李晓雨。你的背景如下：

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
export default function TestPage() {
  const router = useRouter()
  const {
    messages,
    interviewComplete,
    coveredDimensions,
    emptyDimensions,
    targetProgram,
    dimensionSummaries,
    dimensionMessageIndex,
    expMessageIndex,
    activeDimension,
    addMessage,
    updateLastAssistantMessage,
    setInterviewComplete,
    setCoveredDimensions,
    deferDimension,
    setTargetProgram,
    setDimensionSummary,
    setActiveDimension,
    setDimensionMessageIndex,
    setExpMessageIndex,
    markDimensionEmpty,
    removeFromEmpty,
    cvText,
    cvAnalysis,
    quickInfo,
    resetInterview,
    setQuickInfo,
    reset,
  } = useAppStore()

  const [isThinking, setIsThinking] = useState(false)
  const isThinkingRef = useRef(false)
  const [streamingText, setStreamingText] = useState('')
  const [textInput, setTextInput] = useState('')

  const [generatingSummaries, setGeneratingSummaries] = useState<Record<string, boolean>>({})
  const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set())
  const [isRefreshingDimensions, setIsRefreshingDimensions] = useState(false)

  // ── Simulation state ───────────────────────────────────────────────────────
  const simRunningRef = useRef(false)
  const [simRunning, setSimRunning] = useState(false)
  const [simStatus, setSimStatus] = useState<'idle' | 'student'>('idle')
  const [simPersona, setSimPersona] = useState(DEFAULT_PERSONA)
  const [simQuickInfo, setSimQuickInfo] = useState({ school: '', major: '', gpa: '', targetSchool: '', targetMajor: '', degree: '' })
  const [simExperiences, setSimExperiences] = useState({ internship: 0, research: 0 })
  const [showPersonaModal, setShowPersonaModal] = useState(false)
  const [showQuickInfoModal, setShowQuickInfoModal] = useState(false)
  const quickInfoModalIsNewUser = useRef(false)
  const prevIsThinkingRef = useRef(false)
  // ──────────────────────────────────────────────────────────────────────────

  function getDimStart(dim: string): number {
    const formalStart = (['internship', 'research'].includes(dim))
      ? messages.findIndex(m =>
          m.role === 'assistant' &&
          /\[ASKING[：:]\s*academic\]/i.test((m as Message & { rawContent?: string }).rawContent ?? m.content)
        )
      : -1

    if (dim in dimensionMessageIndex) {
      const storedIdx = dimensionMessageIndex[dim]
      if (formalStart < 0 || storedIdx >= formalStart) return storedIdx
    }
    const found = findDimStartInHistory(dim, messages)
    if (found >= 0) return found
    // Last-resort: scan rawContent for [ASKING:dim] or [COVERED:dim] tag
    for (let i = Math.max(0, formalStart); i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const raw = (m as Message & { rawContent?: string }).rawContent ?? m.content
      if (new RegExp(`\\[(ASKING|COVERED)[：:]\\s*${dim}\\]`, 'i').test(raw)) return i
    }
    // Final fallback for late-stage dims: estimate position by coverage order
    const LATE_DIMS = ['motivation', 'plan', 'personal']
    if (LATE_DIMS.includes(dim) && coveredDimensions.includes(dim)) {
      const aiIdxs = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0)
      if (aiIdxs.length > 0) {
        const target = dim === 'motivation' ? 0.6 : dim === 'plan' ? 0.75 : 0.85
        return aiIdxs[Math.floor(aiIdxs.length * target)] ?? aiIdxs[aiIdxs.length - 1]
      }
    }
    return -1
  }

  function getExpStart(expName: string): number {
    if (expName in expMessageIndex) return expMessageIndex[expName]
    // Fuzzy match using bigram overlap (more precise than character overlap)
    const norm = (s: string) => s.toLowerCase().replace(/[\s\-_""''「」【】《》()（）·•,，.。：:]/g, '')
    const normExp = norm(expName)
    const expBigrams = normExp.length >= 2
      ? Array.from({ length: normExp.length - 1 }, (_, k) => normExp.slice(k, k + 2))
      : []
    let bestKey = ''
    let bestScore = 0.7
    for (const key of Object.keys(expMessageIndex)) {
      const normKey = norm(key)
      if (normKey === normExp) return expMessageIndex[key]
      if (expBigrams.length === 0) continue
      const keyBigrams = normKey.length >= 2
        ? Array.from({ length: normKey.length - 1 }, (_, k) => normKey.slice(k, k + 2))
        : []
      const matchCount = expBigrams.filter(bg => keyBigrams.includes(bg)).length
      const score = matchCount / Math.max(expBigrams.length, keyBigrams.length)
      if (score > bestScore) { bestScore = score; bestKey = key }
    }
    if (bestKey) return expMessageIndex[bestKey]
    return findExpStartInHistory(expName, messages)
  }

  const messagesRef = useRef<Message[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const initialized = useRef(false)
  const pendingCompleteRef = useRef(false)
  const summaryGeneratedAtRef = useRef<Record<string, number>>({})

  useEffect(() => { messagesRef.current = messages }, [messages])

  useEffect(() => {
    if (scrollRef.current && !userScrolledRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText, interviewComplete])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (messages.length === 0) {
      callAI([])
    } else if (!targetProgram) {
      inferTargetFromMessages(messages)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Simulation: trigger student reply after AI finishes ────────────────────
  useEffect(() => {
    const wasThinking = prevIsThinkingRef.current
    prevIsThinkingRef.current = isThinking
    if (wasThinking && !isThinking && simRunningRef.current && !interviewComplete) {
      triggerStudentReply()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThinking, interviewComplete])

  // Auto-stop simulation when interview completes
  useEffect(() => {
    if (interviewComplete && simRunningRef.current) {
      simRunningRef.current = false
      setSimRunning(false)
      setSimStatus('idle')
    }
  }, [interviewComplete])
  // ──────────────────────────────────────────────────────────────────────────

  async function callAI(msgs: Message[]) {
    setStreamingText('')
    setIsThinking(true)
    isThinkingRef.current = true
    addMessage({ role: 'assistant', content: '' })

    try {
      const snap = useAppStore.getState()
      const MAX_MSGS = 40
      const msgsToSend = msgs.length > MAX_MSGS ? msgs.slice(msgs.length - MAX_MSGS) : msgs
      const res = await fetch('/api/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: msgsToSend.map(m => ({ role: m.role, content: m.content })),
          coveredDimensions: snap.coveredDimensions,
          deferredDimensions: snap.deferredDimensions,
          emptyDimensions:    snap.emptyDimensions,
          cvText:             '',
          cvAnalysis:         '',
          quickInfo:          snap.quickInfo,
        }),
      })
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errBody.error || `HTTP ${res.status}`)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
        updateLastAssistantMessage(fullText)
        setStreamingText(fullText)
      }

      const { clean, covered, empty, deferred, asking, exp, complete, target } = parseAIMessage(fullText)
      updateLastAssistantMessage(clean, fullText)
      setStreamingText('')
      if (target) {
        setTargetProgram(target)
      } else if (!useAppStore.getState().targetProgram) {
        inferTargetFromMessages([...msgs, { role: 'assistant', content: clean }])
      }

      if (exp.length > 0) {
        const msgIdx = useAppStore.getState().messages.length - 1
        exp.forEach(name => {
          if (!(name in useAppStore.getState().expMessageIndex)) {
            setExpMessageIndex(name, msgIdx)
          }
        })
      }

      if (empty.length > 0) {
        const GUARDED_DIMS = ['research', 'internship']
        const allMsgsSoFar = messagesRef.current
        const formalInterviewStarted = allMsgsSoFar.some(m =>
          m.role === 'assistant' &&
          /\[ASKING[：:]\s*academic\]/i.test(m.rawContent ?? m.content)
        )
        const safeEmpty = empty.filter(dim => {
          if (!GUARDED_DIMS.includes(dim)) return true
          // Pre-screening phase: allow without [ASKING:dim]
          if (!formalInterviewStarted) return true
          return allMsgsSoFar.some(m =>
            m.role === 'assistant' &&
            new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i').test(m.rawContent ?? m.content)
          )
        })
        safeEmpty.forEach(dim => markDimensionEmpty(dim))
        setCoveredDimensions(safeEmpty)
      }
      if (covered.length > 0) {
        setCoveredDimensions(covered)
        covered.forEach(dim => generateDimensionSummary(dim))
      }

      {
        const EXP_ORDER = ['project', 'internship', 'research'] as const
        const newlyResolved = [...covered, ...empty].filter(d => EXP_DIMS.includes(d))
        if (newlyResolved.length > 0) {
          const minIdx = Math.min(...newlyResolved.map(d => EXP_ORDER.indexOf(d as typeof EXP_ORDER[number])))
          const sSnap = useAppStore.getState()
          const toRefresh = EXP_ORDER.slice(0, minIdx).filter(d =>
            sSnap.coveredDimensions.includes(d) || sSnap.emptyDimensions.includes(d)
          )
          ;(async () => {
            for (const d of toRefresh) {
              await generateDimensionSummary(d)
            }
          })()
        }
      }

      {
        const s = useAppStore.getState()
        const priorUserTurns = msgs.filter(m => m.role === 'user').length
        const personalDone = covered.includes('personal') || s.coveredDimensions.includes('personal')
        if (personalDone && priorUserTurns >= 6) {
          const toForce = ['motivation', 'plan'].filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      if (asking.length === 0) {
        const DIM_ORDER = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']
        const INFER_KW: Record<string, RegExp> = {
          internship: /实习经历|有没有.*实习|聊聊.*实习|兼职/,
          research:   /科研经历|有没有.*科研|聊聊.*科研|课题组|帮.*老师.*做|实验室.*科研|科研.*实验室|发表.*论文|投稿/,
          motivation: /申请动机|为什么.*申请|为什么.*出国|什么.*吸引.*你|选择.*这个.*方向|为什么.*选择|让你.*决定.*申请|什么让你.*想.*申请|吸引你的是|这个方向.*吸引|让你觉得.*吸引|对.*学校.*感兴趣|对.*专业.*感兴趣|为什么.*对.*感兴趣|让你.*对.*投入|决定.*深造|决定.*继续|是什么.*让你.*决定|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这/,
          plan:       /毕业后.*[想希打做]|未来.*规划|职业.*目标|长期.*打算|毕业.*之后|读完.*之后|硕士.*之后|博士.*之后|有什么.*规划|有没有.*规划|有没有.*打算|初步.*规划|初步.*想法/,
          personal:   /个人特质|你.*核心.*特质|让你.*突破.*瓶颈|成长最多|你自己.*有这种感觉|你这个人/,
        }
        const sInfer = useAppStore.getState()
        const curActive = sInfer.activeDimension
        const curIdx = curActive ? DIM_ORDER.indexOf(curActive) : -1
        for (const [dim, kw] of Object.entries(INFER_KW)) {
          const dimIdx = DIM_ORDER.indexOf(dim)
          if (dimIdx <= curIdx && dim !== 'motivation') continue
          if (kw.test(fullText) && /[？?]/.test(fullText) &&
              !sInfer.coveredDimensions.includes(dim) && !sInfer.emptyDimensions.includes(dim)) {
            asking.push(dim)
            break
          }
        }
      }

      deferred.forEach(dim => deferDimension(dim))
      if (asking.length > 0) {
        const prevDim = useAppStore.getState().activeDimension
        const s = useAppStore.getState()
        if (prevDim && s.coveredDimensions.includes(prevDim)) {
          generateDimensionSummary(prevDim)
        } else if (prevDim && !s.coveredDimensions.includes(prevDim) && !s.emptyDimensions.includes(prevDim)) {
          // AI transitioned away without outputting [COVERED:prevDim].
          // Auto-recover using dimensionMessageIndex to find where AI first asked about prevDim,
          // then check if user replied with substantial content after that point.
          const allMsgs = [...msgs, { role: 'assistant' as const, content: fullText }]
          const askStart = s.dimensionMessageIndex[prevDim] ?? -1
          const searchFrom = askStart >= 0 ? askStart : (() => {
            return allMsgs.reduce((found, m, i) =>
              found === -1 && m.role === 'assistant' &&
              new RegExp(`\\[ASKING[：:]\\s*${prevDim}\\]`, 'i').test((m as Message & { rawContent?: string }).rawContent ?? m.content)
              ? i : found, -1)
          })()
          if (searchFrom >= 0) {
            const userRepliedAfter = allMsgs.slice(searchFrom + 1).some(
              u => u.role === 'user' && u.content.trim().length > 8
            )
            if (userRepliedAfter) {
              setCoveredDimensions([prevDim])
              generateDimensionSummary(prevDim)
            }
          }
        }
        asking.forEach(d => {
          if (useAppStore.getState().emptyDimensions.includes(d)) removeFromEmpty(d)
        })
        setActiveDimension(asking[0])
        const currentMsgIdx = useAppStore.getState().messages.length - 1
        asking.forEach(d => {
          if (!(d in useAppStore.getState().dimensionMessageIndex)) {
            setDimensionMessageIndex(d, currentMsgIdx)
          }
        })
      }

      const msgsForDetection: Message[] = [
        ...msgs.map(m => ({ role: m.role, content: m.rawContent ?? m.content } as Message)),
        { role: 'assistant', content: fullText },
      ]
      const msgsWithResponse = msgsForDetection

      recoverMissedTagsFromHistory(msgsWithResponse)
      detectCoverageWithAI(msgsWithResponse)

      const currentDim = useAppStore.getState().activeDimension
      if (currentDim && useAppStore.getState().coveredDimensions.includes(currentDim)) {
        const totalMsgs = msgsWithResponse.length
        const lastAt = summaryGeneratedAtRef.current[currentDim] ?? 0
        if (totalMsgs - lastAt >= 6) {
          summaryGeneratedAtRef.current[currentDim] = totalMsgs
          generateDimensionSummary(currentDim)
        }
      }

      if (complete) {
        const ALL_DIMENSIONS = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']
        {
          const s = useAppStore.getState()
          const toForce = ALL_DIMENSIONS.filter(d => {
            if (s.coveredDimensions.includes(d)) return false
            const askIdx = msgsWithResponse.findIndex(m =>
              m.role === 'assistant' &&
              new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(m.rawContent ?? m.content)
            )
            if (askIdx === -1) return false
            return msgsWithResponse.slice(askIdx + 1).some(m => m.role === 'user')
          })
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }

        const userTurnCount = msgsWithResponse.filter(m => m.role === 'user').length
        const lastAiContent = fullText.replace(/\[[\w:,\s|]+\]/g, '').trim()
        const endsWithQuestion = /[？?]/.test(lastAiContent.slice(-200))
        if (userTurnCount >= 8 && !endsWithQuestion) {
          const sNow = useAppStore.getState()
          const activeDim = sNow.activeDimension
          if (activeDim && !sNow.coveredDimensions.includes(activeDim) && !sNow.emptyDimensions.includes(activeDim)) {
            sNow.setCoveredDimensions([activeDim])
          }
          pendingCompleteRef.current = true
        }
      }
    } catch (err) {
      console.error(err)
      updateLastAssistantMessage('抱歉，出了点问题，请重试。')
    } finally {
      setIsThinking(false)
      isThinkingRef.current = false
      if (pendingCompleteRef.current) {
        pendingCompleteRef.current = false
        setInterviewComplete(true)
      }
    }
  }

  async function handleSend(text: string) {
    if (!text.trim() || isThinking) return
    setTextInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    const userMsg: Message = { role: 'user', content: text.trim() }
    addMessage(userMsg)
    await callAI([...messagesRef.current, userMsg])
  }

  async function handleRefreshDimensions() {
    if (isRefreshingDimensions) return
    setIsRefreshingDimensions(true)
    try {
      const msgs = messagesRef.current
      recoverMissedTagsFromHistory(msgs)
      await detectCoverageWithAI(msgs)

      const QUESTION_KW: Record<string, RegExp> = {
        motivation: /为什么.*申请|为什么.*出国|申请.*动机|什么.*促使|驱动你|想来.*读|想出来|什么.*吸引|感兴趣.*原因|让你.*感兴趣|对.*项目.*感兴趣|为什么.*香港|香港.*吸引|什么让你.*选择|选择.*申请|让你.*决定.*申请|什么让你.*想.*申请|吸引你的是|这个方向.*吸引|让你觉得.*吸引|对.*学校.*感兴趣|对.*专业.*感兴趣|为什么.*对.*感兴趣|让你.*觉得.*这个方向|让你.*对.*投入|决定.*深造|决定.*继续|是什么.*让你.*决定|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这/i,
        plan:       /未来规划|职业规划|毕业后.*[想希打做]|毕业.*打算|职业.*目标|职业.*方向|未来.*打算|长期.*目标|短期.*计划/i,
        personal:   /印象深刻|让你成长|成长.*经历|改变.*想法|你.*特点|自我.*认知|你.*是.*怎样.*人|内在驱动|做事.*模式|你.*感觉.*这种|有了新的认识|认识或成长|遇到的困难.*大|结果.*不如预期|你.*核心.*特质|你身上.*特质|你这个人|最后一个问题|有没有哪一次|哪一次.*经历|哪一次.*挑战|具体的经历.*挑战|让你.*锻炼|让你.*深刻|让你.*认识|让你.*有了|连接.*能力|这种.*能力.*得到/i,
        research:   /有没有.*科研|做过.*科研|参与.*研究|加入.*实验室|帮.*老师.*课题/i,
      }
      {
        const s = useAppStore.getState()
        const localForce = Object.entries(QUESTION_KW)
          .filter(([dim]) => !s.coveredDimensions.includes(dim))
          .filter(([, pattern]) =>
            msgs.some((m, i) => {
              if (m.role !== 'assistant') return false
              if (!pattern.test(m.rawContent ?? m.content)) return false
              return msgs.slice(i + 1).some(u => u.role === 'user' && u.content.trim().length > 8)
            })
          )
          .map(([dim]) => dim)
        if (localForce.length > 0) s.setCoveredDimensions(localForce)
      }

      // ── Negative-reply detection: asked + user said "no" → mark empty ────────
      {
        const s = useAppStore.getState()
        const NEGATIVE = /^(没有|没|无|也没有|都没有|没做过|没有过|不|没有呢|没有啊|嗯[，,].*没有|这个.*没有|这个也没有|没有[。.！!]?|暂时没有|目前没有)[。.！!]?$/
        const EXP_DIMS = ['internship', 'research']
        const toEmpty = EXP_DIMS
          .filter(dim => !s.coveredDimensions.includes(dim) && !s.emptyDimensions.includes(dim))
          .filter(dim => {
            const kw = QUESTION_KW[dim as keyof typeof QUESTION_KW]
            if (!kw) return false
            return msgs.some((m, i) => {
              if (m.role !== 'assistant') return false
              if (!kw.test(m.rawContent ?? m.content)) return false
              const replies = msgs.slice(i + 1).filter(u => u.role === 'user')
              return replies.length > 0 && replies.every(u => NEGATIVE.test(u.content.trim()))
            })
          })
        if (toEmpty.length > 0) {
          toEmpty.forEach(dim => s.markDimensionEmpty(dim))
        }
      }

      {
        const s = useAppStore.getState()
        if (s.coveredDimensions.includes('personal')) {
          const toForce = ['motivation', 'plan'].filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      {
        const s = useAppStore.getState()
        const WRAP_UP = /接下来.*系统会|系统会.*提炼.*叙事|帮你提炼.*叙事方向|接下来可以去看看.*叙事方向|祝你申请顺利|今天的访谈就到这里|信息非常充分/i
        const lastAI = [...msgs].reverse().find(m => m.role === 'assistant')
        const userReplies = msgs.filter(m => m.role === 'user').length
        if (lastAI && WRAP_UP.test(lastAI.rawContent ?? lastAI.content) && userReplies >= 8) {
          const ALL_DIMS = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']
          const toForce = ALL_DIMS.filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      await generateAllSummaries(useAppStore.getState().coveredDimensions)
    } finally {
      setIsRefreshingDimensions(false)
    }
  }

  const EXP_DIMS = ['project', 'internship', 'research']

  async function generateDimensionSummary(dimension: string) {
    if (generatingSummaries[dimension]) return

    setGeneratingSummaries(prev => ({ ...prev, [dimension]: true }))
    summaryGeneratedAtRef.current[dimension] = useAppStore.getState().messages.length

    try {
      const res = await fetch('/api/summarize-dimension', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dimension,
          messages: useAppStore.getState().messages,
          cvText: '',
          cvAnalysis: '',
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      if (data.summary) {
        setDimensionSummary(dimension, data.summary)
        useAppStore.getState().setStep1Summary(dimension, '')
      }
    } catch (error) {
      console.error(`生成维度"${dimension}"总结失败:`, error)
      const fallbackSummary = `已了解用户的${INTERVIEW_DIMENSIONS.find(d => d.key === dimension)?.label || dimension}相关信息`
      setDimensionSummary(dimension, fallbackSummary)
    } finally {
      setGeneratingSummaries(prev => ({ ...prev, [dimension]: false }))
    }
  }

  async function generateAllSummaries(dims: string[]) {
    await Promise.all(dims.map(dim => generateDimensionSummary(dim)))
  }

  useEffect(() => {
    const pending = coveredDimensions.filter(dim => !dimensionSummaries[dim] && !generatingSummaries[dim])
    if (pending.length > 0) generateAllSummaries(pending)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, dimensionSummaries, generatingSummaries])

  // Auto-recover plan/motivation when personal is done
  useEffect(() => {
    if (!coveredDimensions.includes('personal')) return
    const toRecover = ['motivation', 'plan'].filter(
      d => !coveredDimensions.includes(d) && !emptyDimensions.includes(d)
    )
    if (toRecover.length === 0) return
    const msgs = messagesRef.current
    const src = (m: Message) => (m as Message & { rawContent?: string }).rawContent ?? m.content
    const PLAN_KW = /毕业后|未来.*规划|职业.*目标|职业.*方向|未来.*打算|长期.*目标|短期.*计划|读完.*之后|硕士.*之后|博士.*之后|毕业.*之后|毕业.*打算|以后.*[想打]|将来.*[想打]|有什么.*规划|有没有.*规划|有没有.*打算|初步.*想法|初步.*规划/i
    const MOTIV_KW = /为什么.*申请|为什么.*出国|申请.*动机|什么.*吸引|感兴趣.*原因|让你.*感兴趣|让你.*投入|决定.*深造|决定.*继续|是什么.*让你.*决定|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这|吸引你的是|这个方向.*吸引/i
    const KW: Record<string, RegExp> = { plan: PLAN_KW, motivation: MOTIV_KW }
    const verified = toRecover.filter(dim => {
      const askIdx = msgs.findIndex(m =>
        m.role === 'assistant' &&
        new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i').test(src(m))
      )
      if (askIdx >= 0) {
        return msgs.slice(askIdx + 1).some(u => u.role === 'user' && u.content.trim().length > 8)
      }
      const kw = KW[dim]
      if (!kw) return false
      return msgs.some((m, i) =>
        m.role === 'assistant' && kw.test(src(m)) && /[？?]/.test(src(m)) &&
        msgs.slice(i + 1).some(u => u.role === 'user' && u.content.trim().length > 8)
      )
    })
    if (verified.length > 0) useAppStore.getState().setCoveredDimensions(verified)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, emptyDimensions])

  // ── Auto-detect personal when plan is covered ───────────────────────────────
  useEffect(() => {
    if (coveredDimensions.includes('personal')) return
    if (emptyDimensions.includes('personal')) return
    if (!coveredDimensions.includes('plan')) return
    const msgs = messagesRef.current
    const src = (m: Message) => (m as Message & { rawContent?: string }).rawContent ?? m.content
    const PERSONAL_KW = /印象深刻|让你成长|成长.*经历|改变.*想法|你.*特点|自我.*认知|你.*是.*怎样.*人|内在驱动|做事.*模式|你.*感觉.*这种|有了新的认识|认识或成长|遇到的困难.*大|结果.*不如预期|你.*核心.*特质|你身上.*特质|你这个人|最后一个问题|有没有哪一次|哪一次.*经历|哪一次.*挑战|具体的经历.*挑战|让你.*锻炼|让你.*深刻|让你.*认识|让你.*有了|连接.*能力|这种.*能力.*得到/i
    const asked = msgs.some((m, i) =>
      m.role === 'assistant' &&
      PERSONAL_KW.test(src(m)) &&
      msgs.slice(i + 1).some(u => u.role === 'user' && u.content.trim().length > 8)
    )
    if (asked) useAppStore.getState().setCoveredDimensions(['personal'])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, emptyDimensions])

  useEffect(() => {
    if (interviewComplete) return
    if (isThinkingRef.current) return
    const ALL_DIMENSIONS = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']
    const msgs = messagesRef.current
    const userTurns = msgs.filter(m => m.role === 'user').length
    if (userTurns < 8) return

    const s = useAppStore.getState()
    const coveredSet = new Set(s.coveredDimensions)
    const empty = [...s.emptyDimensions]

    const src = (m: { rawContent?: string; content: string }) => m.rawContent ?? m.content
    const lastMsg = msgs[msgs.length - 1]
    const lastContent = lastMsg ? src(lastMsg) : ''
    const aiHasConcluded = lastMsg?.role === 'assistant' && !/[？?]/.test(lastContent.slice(-400))

    if (aiHasConcluded) {
      const toForceCover: string[] = []
      const toForceEmpty: string[] = []

      const activeDim = s.activeDimension
      if (activeDim && !coveredSet.has(activeDim) && !empty.includes(activeDim)) {
        toForceCover.push(activeDim)
        coveredSet.add(activeDim)
      }

      for (const d of ALL_DIMENSIONS) {
        if (coveredSet.has(d) || empty.includes(d)) continue
        const askIdx = msgs.reduce((found, m, i) =>
          m.role === 'assistant' && new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(src(m)) ? i : found, -1)
        if (askIdx === -1) continue
        const afterAsk = msgs.slice(askIdx + 1)
        const userReplies = afterAsk.filter(m => m.role === 'user')
        if (userReplies.length === 0) continue
        const allNegative = userReplies.every(m => /^(没有|没|无|也没有|都没有|没做过|没有过|不|没有呢|没有啊)$/.test(m.content.trim()))
        if (allNegative) toForceEmpty.push(d)
        else toForceCover.push(d)
      }
      if (toForceCover.length > 0) { s.setCoveredDimensions(toForceCover); toForceCover.forEach(d => coveredSet.add(d)) }
      if (toForceEmpty.length > 0) { toForceEmpty.forEach(d => { s.markDimensionEmpty(d); empty.push(d) }) }
    }

    const allDone = ALL_DIMENSIONS.every(d => coveredSet.has(d) || empty.includes(d))
    // Don't complete if the last AI message ends with a question — student hasn't answered yet.
    const lastAiMsg = [...msgs].reverse().find(m => m.role === 'assistant')
    const lastAiEndsWithQuestion = lastAiMsg && /[？?]/.test((lastAiMsg.rawContent ?? lastAiMsg.content).replace(/\[[\w:,\s|]+\]/g, '').trimEnd().slice(-300))
    if (allDone && !lastAiEndsWithQuestion) setInterviewComplete(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, emptyDimensions, messages.length])

  // ── Simulation functions ───────────────────────────────────────────────────
  async function triggerStudentReply() {
    if (!simRunningRef.current) return
    setSimStatus('student')
    try {
      const qi = simQuickInfo
      const overrideParts: string[] = []
      if (qi.school) overrideParts.push(`就读院校：${qi.school}`)
      if (qi.major) overrideParts.push(`就读专业：${qi.major}`)
      if (qi.gpa) overrideParts.push(`GPA：${qi.gpa}`)
      if (qi.targetSchool) overrideParts.push(`目标院校：${qi.targetSchool}`)
      if (qi.targetMajor) overrideParts.push(`申请专业：${qi.targetMajor}`)
      if (qi.degree) overrideParts.push(`申请学位：${qi.degree}`)
      overrideParts.push(simExperiences.internship > 0
        ? `实习经历：有 ${simExperiences.internship} 段正式实习，被问到时按下方 persona 描述回答（如 persona 无对应内容则自行编造合理的${simExperiences.internship}段实习经历）`
        : '实习经历：无正式实习，被问到时如实说没有实习过')
      overrideParts.push(simExperiences.research > 0
        ? `科研经历：有 ${simExperiences.research} 段科研经历，被问到时按下方 persona 描述回答（如 persona 无对应内容则自行编造合理的${simExperiences.research}段科研经历）`
        : '科研经历：无，被问到时如实说没有科研经历')
      const persona = `【重要覆盖】以下信息优先级最高，覆盖下方 persona 中的对应字段，回答时必须使用这里的信息：\n${overrideParts.join('\n')}\n\n` + simPersona

      const res = await fetch('/api/test-reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: messagesRef.current,
          personaPrompt: persona,
          quickInfo: Object.values(qi).some(v => v.trim()) ? qi : null,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { reply, error: replyError } = await res.json()
      if (replyError) throw new Error(replyError)
      if (simRunningRef.current && reply) {
        await handleSend(reply)
      }
    } catch (e) {
      console.error('Student sim error:', e)
      simRunningRef.current = false
      setSimRunning(false)
    } finally {
      if (simRunningRef.current) setSimStatus('idle')
    }
  }

  function startSim() {
    const qi = simQuickInfo
    if (Object.values(qi).some(v => v.trim())) {
      setQuickInfo(qi)
    }
    simRunningRef.current = true
    setSimRunning(true)
    if (!isThinkingRef.current && !interviewComplete) {
      triggerStudentReply()
    }
  }

  function stopSim() {
    simRunningRef.current = false
    setSimRunning(false)
    setSimStatus('idle')
  }
  // ──────────────────────────────────────────────────────────────────────────

  const roundCount = messages.filter((m) => m.role === 'user').length
  const displayMessages = messages.map((m, i) => {
    if (m.role === 'assistant' && i === messages.length - 1 && isThinking && streamingText) {
      const { clean } = parseAIMessage(streamingText)
      return { ...m, content: clean, streaming: true }
    }
    if (m.role === 'assistant') {
      const { clean } = parseAIMessage(m.content)
      return { ...m, content: clean, streaming: false }
    }
    return { ...m, streaming: false }
  })

  return (
    <div className="flex h-screen bg-[#FAF9F6] overflow-hidden">
      {/* ══ Main chat area ══ */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-stone-200" style={{ minWidth: 'calc(100% - 300px)' }}>
        {/* Header */}
        <header className="shrink-0 border-b border-stone-200 bg-[#FAF9F6] px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-orange-400 font-bold tracking-tight">EssayMind</Link>
            <div className="flex items-center gap-2 text-sm text-stone-400">
              <span className="text-stone-800 font-medium">深度访谈</span>
              <span className="text-stone-300 text-xs bg-stone-100 px-1.5 py-0.5 rounded font-mono">TEST</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                stopSim()
                reset()
                setSimQuickInfo({ school: '', major: '', gpa: '', targetSchool: '', targetMajor: '', degree: '' })
                setSimExperiences({ internship: 0, research: 0 })
                quickInfoModalIsNewUser.current = true
                setShowQuickInfoModal(true)
              }}
              className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
            >
              切换用户
            </button>
            <button
              onClick={() => {
                if (messages.length === 0) return
                const qi = quickInfo
                const lines: string[] = []
                lines.push('# 采访对话记录')
                lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`)
                if (qi) {
                  const info = [qi.school, qi.major, qi.gpa, qi.targetSchool, qi.targetMajor, qi.degree].filter(Boolean)
                  if (info.length > 0) lines.push(`用户信息：${info.join(' | ')}`)
                }
                lines.push('')
                messages.forEach((m, i) => {
                  const role = m.role === 'assistant' ? 'Omi' : '学生'
                  const { clean } = parseAIMessage(m.content)
                  lines.push(`【${role}】`)
                  lines.push(clean || m.content)
                  lines.push('')
                })
                const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = url
                a.download = `采访记录_${new Date().toISOString().slice(0, 10)}.txt`
                a.click()
                URL.revokeObjectURL(url)
              }}
              disabled={messages.length === 0}
              className="text-xs text-stone-400 hover:text-stone-600 disabled:opacity-30 transition-colors"
            >
              导出对话
            </button>
            <button
              onClick={() => {
                if (confirm('重新开始采访？对话记录将清除，简历和基本信息会保留。')) {
                  stopSim()
                  resetInterview()
                  initialized.current = false
                  window.location.reload()
                }
              }}
              className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
            >
              重新开始
            </button>
          </div>
        </header>

        {/* Messages */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-4 py-8 bg-[#FAF9F6]"
          onScroll={() => {
            const el = scrollRef.current
            if (!el) return
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
            userScrolledRef.current = !atBottom
          }}
        >
          <div className="max-w-2xl mx-auto space-y-7">
            {displayMessages.map((m, i) => (
              <div
                key={i}
                id={`msg-${i}`}
                className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}
              >
                {m.role === 'assistant' ? (
                  <div className="w-7 h-7 shrink-0 mt-1">
                    <Mascot
                      size={28}
                      mood={isThinking && i === displayMessages.length - 1 ? 'thinking' : 'idle'}
                    />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full bg-stone-700 flex items-center justify-center text-stone-200 text-[10px] font-semibold shrink-0 mt-1">
                    我
                  </div>
                )}

                <div className={`max-w-[78%] flex flex-col gap-1 ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                  <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.role === 'assistant'
                      ? 'text-stone-800'
                      : 'bg-stone-800 text-white rounded-tr-sm'
                  }`}>
                    {m.content ? (
                      <span>
                        {m.content}
                        {m.streaming && (
                          <span className="inline-block w-0.5 h-3.5 bg-stone-400 ml-0.5 animate-pulse align-middle" />
                        )}
                      </span>
                    ) : isThinking && i === displayMessages.length - 1 ? (
                      <span className="flex gap-1.5 items-center py-0.5 px-1">
                        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-stone-300" />
                        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-stone-300" />
                        <span className="typing-dot w-1.5 h-1.5 rounded-full bg-stone-300" />
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}

            {interviewComplete && (
              <div className="bg-white border border-stone-200 rounded-xl px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Mascot size={40} mood="happy" className="shrink-0" />
                  <div>
                    <p className="text-stone-800 font-semibold text-sm">采访完成，Omi 已充分了解你的背景</p>
                    <p className="text-stone-400 text-xs mt-0.5">可以选择叙事方向，生成文书框架了</p>
                  </div>
                </div>
                <button
                  onClick={() => router.push('/highlights')}
                  className="bg-orange-400 hover:bg-orange-500 text-white font-medium text-sm px-5 py-2.5 rounded-xl transition-colors shrink-0 ml-4 animate-bounce"
                >
                  选择人设方向 →
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Input area */}
        <div className="shrink-0 bg-[#FAF9F6] px-4 pb-5 pt-3">
          <div className="max-w-2xl mx-auto">
            {!interviewComplete && !isThinking && messages.some(m => m.role === 'assistant') && (
              <div className="flex justify-end gap-3 mb-2">
                <button
                  onClick={() => handleSend('这个问题我不太清楚怎么回答，你能换个方式问我吗？')}
                  className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors"
                >
                  换个方式问
                </button>
                <button
                  onClick={() => handleSend('这个问题我答不上来，跳过这道题，但继续聊这段经历吧。')}
                  className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors"
                >
                  跳过此问题
                </button>
              </div>
            )}
            <div className="flex gap-2 items-end bg-white border border-stone-200 rounded-2xl px-3 py-2 shadow-sm focus-within:border-stone-300 transition-colors">
              <textarea
                ref={textareaRef}
                value={textInput}
                onChange={(e) => {
                  setTextInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend(textInput)
                  }
                }}
                placeholder="回复 Omi…"
                disabled={isThinking}
                rows={1}
                className="flex-1 bg-transparent text-sm text-stone-800 placeholder-stone-400 resize-none focus:outline-none disabled:opacity-50 py-1.5 px-1"
                style={{ minHeight: '36px', maxHeight: '160px' }}
              />
              <div className="flex items-center gap-1.5 shrink-0 pb-1">
                <button
                  onClick={() => handleSend(textInput)}
                  disabled={isThinking || !textInput.trim()}
                  className="w-9 h-9 rounded-xl bg-stone-500 hover:bg-stone-600 disabled:opacity-30 text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            </div>
            <p className="text-[11px] text-stone-400 mt-2 text-center">Enter 发送 · Shift+Enter 换行</p>
          </div>
        </div>
      </div>

      {/* ══ Right sidebar ══ */}
      <aside className="w-[300px] shrink-0 bg-[#FAF9F6] flex flex-col overflow-hidden">
        {/* Advisor info */}
        <div className="p-4 border-b border-stone-200">
          <div className="flex items-center gap-3 mb-3">
            <Mascot size={36} mood={isThinking ? 'thinking' : simStatus === 'student' ? 'thinking' : 'idle'} className="shrink-0" />
            <div>
              <div className="text-stone-800 font-semibold text-sm">Omi</div>
              <div className="text-stone-400 text-xs">AI 留学顾问精灵</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className={`w-1.5 h-1.5 rounded-full ${
                  interviewComplete ? 'bg-stone-400'
                  : isThinking ? 'bg-amber-400 animate-pulse'
                  : simStatus === 'student' ? 'bg-blue-400 animate-pulse'
                  : 'bg-emerald-400'
                }`} />
                <span className={`text-xs ${
                  interviewComplete ? 'text-stone-600'
                  : isThinking ? 'text-amber-600'
                  : simStatus === 'student' ? 'text-blue-600'
                  : 'text-emerald-600'
                }`}>
                  {interviewComplete ? '采访完成 ✓' : isThinking ? '思考中…' : simStatus === 'student' ? '学生回答中…' : '采访进行中'}
                </span>
              </div>
            </div>
          </div>

          {targetProgram ? (
            <div className="bg-white border border-stone-200 rounded-lg px-3 py-2 mb-2">
              <p className="text-[10px] text-stone-400 font-medium mb-1 uppercase tracking-wider">目标项目</p>
              {targetProgram.split('|').map((part, i) => {
                const labels = ['院校', '专业', '学位']
                const value = part.trim()
                if (!value || /待确认|[?？]/.test(value)) return null
                return (
                  <p key={i} className="text-xs text-stone-600 leading-tight">
                    <span className="text-stone-400">{labels[i]}：</span>{value}
                  </p>
                )
              })}
            </div>
          ) : quickInfo && (quickInfo.targetSchool || quickInfo.targetMajor || quickInfo.degree) ? (
            <div className="bg-white border border-stone-200 rounded-lg px-3 py-2 mb-2">
              <p className="text-[10px] text-stone-400 font-medium mb-1 uppercase tracking-wider">目标项目</p>
              {quickInfo.targetSchool && (
                <p className="text-xs text-stone-600 leading-tight"><span className="text-stone-400">院校：</span>{quickInfo.targetSchool}</p>
              )}
              {quickInfo.targetMajor && (
                <p className="text-xs text-stone-600 leading-tight"><span className="text-stone-400">专业：</span>{quickInfo.targetMajor}</p>
              )}
              {quickInfo.degree && (
                <p className="text-xs text-stone-600 leading-tight"><span className="text-stone-400">学位：</span>{quickInfo.degree}</p>
              )}
            </div>
          ) : (
            <div className="bg-white border border-stone-100 rounded-lg px-3 py-2 mb-2">
              <p className="text-[10px] text-stone-300 italic">了解目标院校中…</p>
            </div>
          )}

          <div className="text-xs text-stone-400 text-center">
            已对话 <span className="text-stone-600 font-semibold">{roundCount}</span> 轮
          </div>
        </div>

        {/* ── AI simulation panel ─────────────────────────────────────────────── */}
        <div className="px-4 py-3 border-b border-stone-200 bg-stone-50/60">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[11px] font-semibold text-stone-500 uppercase tracking-wider">AI 模拟</p>
            <div className="flex items-center gap-1.5">
              <div className={`w-1.5 h-1.5 rounded-full ${simRunning ? simStatus === 'student' ? 'bg-blue-400 animate-pulse' : 'bg-emerald-400 animate-pulse' : 'bg-stone-300'}`} />
              <span className="text-[10px] text-stone-400">
                {simRunning ? simStatus === 'student' ? '学生回答中' : '运行中' : '未启动'}
              </span>
            </div>
          </div>
          <div className="flex gap-1.5 mb-1.5">
            {!simRunning ? (
              <button
                onClick={startSim}
                disabled={isThinking || interviewComplete}
                className="flex-1 bg-stone-800 text-white text-xs py-1.5 rounded-lg hover:bg-stone-700 disabled:opacity-40 transition-colors"
              >
                启动模拟
              </button>
            ) : (
              <button
                onClick={stopSim}
                className="flex-1 bg-red-500 text-white text-xs py-1.5 rounded-lg hover:bg-red-600 transition-colors"
              >
                停止
              </button>
            )}
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => setShowPersonaModal(true)}
              disabled={simRunning}
              className="flex-1 border border-stone-200 text-stone-400 text-[10px] py-1 rounded-md hover:border-stone-400 disabled:opacity-40 transition-colors"
            >
              编辑 Persona
            </button>
            <button
              onClick={() => setShowQuickInfoModal(true)}
              disabled={simRunning}
              className="flex-1 border border-stone-200 text-stone-400 text-[10px] py-1 rounded-md hover:border-stone-400 disabled:opacity-40 transition-colors"
            >
              用户信息
            </button>
          </div>
        </div>
        {/* ──────────────────────────────────────────────────────────────────── */}

        {/* Covered dimensions */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between">
            <div>
              <p className="text-xs text-stone-500 font-medium">{cvText ? '访谈进度' : '已了解的维度'}</p>
              <p className="text-[10px] text-stone-400 mt-0.5">{cvText ? '基于简历的深度访谈' : '点击已了解的维度查看详情'}</p>
            </div>
            <button
              onClick={handleRefreshDimensions}
              disabled={isRefreshingDimensions || isThinking}
              title="重新检测维度"
              className="text-[11px] text-stone-400 hover:text-stone-600 disabled:opacity-40 transition-colors"
            >
              {isRefreshingDimensions ? '检测中…' : '刷新'}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">

            {cvText && (() => {
              const entries: { name: string; reason: string }[] = []
              let cur: { name: string; reason: string } | null = null
              for (const raw of cvAnalysis.split('\n')) {
                const line = raw.trim()
                if (!line) continue
                if (/^经历名称[：:]/.test(line)) {
                  if (cur) entries.push(cur)
                  cur = { name: line.replace(/^经历名称[：:]/, '').trim(), reason: '' }
                } else if (/^深挖原因[：:]/.test(line) && cur) {
                  cur.reason = line.replace(/^深挖原因[：:]/, '').trim()
                } else if (cur && cur.reason) {
                  cur.reason += ' ' + line
                }
              }
              if (cur) entries.push(cur)

              // Sort by interview order using expMessageIndex insertion order as primary,
              // message-index scan as fallback for untagged experiences.
              const expKeys = Object.keys(expMessageIndex)
              const normSimple = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, '')
              function expKeyRank(name: string): number {
                let idx = expKeys.indexOf(name)
                if (idx >= 0) return idx
                const nn = normSimple(name)
                idx = expKeys.findIndex(k => normSimple(k) === nn)
                if (idx >= 0) return idx
                idx = expKeys.findIndex(k => {
                  const nk = normSimple(k)
                  return nk.includes(nn) || nn.includes(nk)
                })
                return idx
              }
              entries.sort((a, b) => {
                const ra = expKeyRank(a.name)
                const rb = expKeyRank(b.name)
                if (ra >= 0 && rb >= 0) return ra - rb
                if (ra >= 0) return -1
                if (rb >= 0) return 1
                const ia = getExpStart(a.name)
                const ib = getExpStart(b.name)
                return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib)
              })

              const EXP_SUM_DIMS = ['academic', 'project', 'internship', 'research']
              type SecData = { bullets: string[]; dimKey: string }
              const sectionMap = new Map<string, SecData>()

              for (const dk of EXP_SUM_DIMS) {
                const sumText = dimensionSummaries[dk]
                if (!sumText) continue
                if (dk === 'academic') {
                  const bullets = sumText.split('\n').map(l => l.replace(/^[·•]\s*/, '').trim()).filter(Boolean)
                  sectionMap.set('__academic__', { bullets, dimKey: dk })
                } else {
                  const lines = sumText.split('\n')
                  let secTitle: string | null = null
                  let secBullets: string[] = []
                  for (const line of lines) {
                    if (line.startsWith('# ')) {
                      if (secTitle !== null) sectionMap.set(normStr(secTitle), { bullets: secBullets, dimKey: dk })
                      secTitle = line.slice(2).trim()
                      secBullets = []
                    } else {
                      const text = line.replace(/^[·•]\s*/, '').trim()
                      if (text) secBullets.push(text)
                    }
                  }
                  if (secTitle !== null) sectionMap.set(normStr(secTitle), { bullets: secBullets, dimKey: dk })
                }
              }

              function normStr(s: string) {
                return s.toLowerCase().replace(/[\s""''「」【】《》()（）\-_·•,，.。]/g, '')
              }

              function findSection(name: string): SecData | null {
                const norm = normStr(name)
                if (sectionMap.has(norm)) return sectionMap.get(norm)!
                for (const [key, data] of sectionMap) {
                  if (key === '__academic__') continue
                  if (norm.includes(key) || key.includes(norm)) return data
                }
                for (const [key, data] of sectionMap) {
                  if (key === '__academic__') continue
                  const shorter = norm.length < key.length ? norm : key
                  const longer = norm.length < key.length ? key : norm
                  let overlap = 0
                  for (const ch of shorter) { if (longer.includes(ch)) overlap++ }
                  if (shorter.length > 0 && overlap / shorter.length >= 0.6) return data
                }
                return null
              }

              const EXP_DIMS_CV = ['academic', 'project', 'internship', 'research']
              const NON_EXP_DIMS = INTERVIEW_DIMENSIONS.filter(d => !EXP_DIMS_CV.includes(d.key))
              const anyExpGenerating = EXP_DIMS_CV.some(d => generatingSummaries[d])

              return (
                <>
                  <div className="bg-white border border-stone-200 rounded-lg overflow-hidden mb-1">
                    <div className="flex items-center justify-between px-3 py-2 border-b border-stone-100">
                      <span className="text-[11px] font-semibold text-stone-600">深挖经历</span>
                      <span className="text-[10px] text-stone-400">{entries.filter(e => findSection(e.name) !== null).length}/{entries.length} 经历已总结</span>
                    </div>
                    <div className="divide-y divide-stone-100">
                      {entries.length > 0 ? entries.map((entry, i) => {
                        const expKey = `exp_${i}`
                        const isExpanded = expandedDimensions.has(expKey)
                        const sec = findSection(entry.name)
                        const hasSummary = !!sec && sec.bullets.length > 0

                        return (
                          <div key={i}>
                            <div
                              className={`flex gap-2 items-center px-3 py-2.5 ${hasSummary ? 'cursor-pointer hover:bg-stone-50' : ''}`}
                              onClick={() => {
                                if (!hasSummary) return
                                setExpandedDimensions(prev => {
                                  const next = new Set(prev)
                                  isExpanded ? next.delete(expKey) : next.add(expKey)
                                  return next
                                })
                              }}
                            >
                              {hasSummary ? (
                                <span className="w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">✓</span>
                              ) : anyExpGenerating ? (
                                <span className="w-4 h-4 rounded-full bg-orange-100 text-orange-400 text-[9px] font-bold flex items-center justify-center shrink-0 animate-pulse">{i + 1}</span>
                              ) : (
                                <span className="w-4 h-4 rounded-full bg-stone-100 text-stone-300 text-[9px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                              )}
                              <p className={`flex-1 text-[12px] leading-snug ${hasSummary ? 'text-stone-800 font-medium' : 'text-stone-400'}`}>{entry.name}</p>
                              {hasSummary && (
                                <span className={`text-[10px] text-stone-400 transition-transform inline-block shrink-0 ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                              )}
                            </div>
                            {isExpanded && (
                              <div className="px-3 pb-2.5 pt-0 bg-stone-50 border-t border-stone-100">
                                {anyExpGenerating && !hasSummary ? (
                                  <div className="flex items-center gap-2 py-2">
                                    <div className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-pulse shrink-0" />
                                    <p className="text-[11px] text-stone-400">整理中…</p>
                                  </div>
                                ) : hasSummary ? (
                                  <div className="space-y-1 pt-2">
                                    {sec!.bullets.map((b, bi) => (
                                      <div key={bi} className="flex gap-2 items-start">
                                        <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0 mt-1.5" />
                                        <p className="text-[11px] text-stone-500 leading-snug">{b}</p>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                                )}
                                {(() => {
                                  const idx = getExpStart(entry.name)
                                  if (idx < 0) return null
                                  return (
                                    <button
                                      className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        document.getElementById(`msg-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                      }}
                                    >
                                      定位到对话 ↑
                                    </button>
                                  )
                                })()}
                              </div>
                            )}
                          </div>
                        )
                      }) : (
                        <p className="text-[11px] text-stone-300 italic px-3 py-2">访谈按简历大纲进行</p>
                      )}
                    </div>
                  </div>

                  {NON_EXP_DIMS.map((dim) => {
                    const done = coveredDimensions.includes(dim.key)
                    const isActive = !done && activeDimension === dim.key
                    const isGenerating = generatingSummaries[dim.key]
                    const aiSummary = dimensionSummaries[dim.key]
                    const isExpanded = expandedDimensions.has(dim.key)
                    const summaryIsEmpty = !isGenerating && aiSummary && /^(无[。.]?|没有[^\n]{0,20}|暂无[^\n]{0,20})$/.test(aiSummary.trim())
                    const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty
                    const resolved = done || isEmpty

                    return (
                      <div
                        key={dim.key}
                        className={`rounded-lg border transition-all ${
                          resolved && !isEmpty
                            ? isExpanded ? 'bg-white border-stone-200' : 'bg-white border-stone-200 cursor-pointer hover:border-stone-300'
                            : resolved && isEmpty ? 'bg-stone-50 border-stone-200'
                            : isActive ? 'bg-stone-50 border-stone-200'
                            : 'border-stone-100'
                        }`}
                      >
                        <div
                          className={`flex items-center gap-2.5 px-3 py-2.5 ${resolved && !isEmpty ? 'cursor-pointer' : ''}`}
                          onClick={() => {
                            if (!resolved || isEmpty) return
                            setExpandedDimensions(prev => {
                              const next = new Set(prev)
                              isExpanded ? next.delete(dim.key) : next.add(dim.key)
                              return next
                            })
                          }}
                        >
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold ${
                            resolved && !isEmpty ? 'bg-stone-900 text-white'
                            : resolved && isEmpty ? 'bg-stone-300 text-white'
                            : isActive ? 'bg-stone-100 text-stone-600'
                            : 'bg-stone-100 text-stone-300'
                          }`}>
                            {resolved && !isEmpty ? '✓' : resolved && isEmpty ? '—' : '·'}
                          </span>
                          <span className={`flex-1 text-[13px] ${
                            resolved && !isEmpty ? 'text-stone-700 font-medium'
                            : resolved && isEmpty ? 'text-stone-400 line-through decoration-stone-300'
                            : isActive ? 'text-stone-700'
                            : 'text-stone-300'
                          }`}>{dim.label}</span>
                          {resolved && !isEmpty && (
                            isGenerating
                              ? <span className="text-[10px] text-stone-400 animate-pulse">…</span>
                              : <span className={`text-[10px] text-stone-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                          )}
                          {resolved && isEmpty && <span className="text-[10px] text-stone-400 bg-stone-200 px-1.5 py-0.5 rounded-full font-medium">无</span>}
                          {isActive && <span className="text-[10px] text-stone-500 animate-pulse">进行中</span>}
                        </div>
                        {resolved && !isEmpty && isExpanded && (
                          <div className="px-3 pb-3 pt-0 border-t border-stone-100">
                            {isGenerating ? (
                              <div className="flex items-center gap-2 py-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-pulse shrink-0" />
                                <p className="text-[11px] text-stone-400">整理中…</p>
                              </div>
                            ) : aiSummary ? (
                              <div className="space-y-1 pt-2">
                                {aiSummary.split('\n').map(l => l.replace(/^[·•]\s*/, '').trim()).filter(Boolean).map((b, bi) => (
                                  <div key={bi} className="flex gap-2 items-start">
                                    <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0 mt-1.5" />
                                    <p className="text-[11px] text-stone-500 leading-snug">{b}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                            )}
                            {getDimStart(dim.key) >= 0 && (
                              <button
                                className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const idx = getDimStart(dim.key)
                                  if (idx < 0) return
                                  document.getElementById(`msg-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                }}
                              >
                                定位到对话 ↑
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )
            })()}

            {!cvText && INTERVIEW_DIMENSIONS.map((dim) => {
              const done = coveredDimensions.includes(dim.key)
              const isActive = !done && activeDimension === dim.key
              const isGenerating = generatingSummaries[dim.key]
              const aiSummary = dimensionSummaries[dim.key]
              const isExpanded = expandedDimensions.has(dim.key)
              const summaryIsEmpty = !isGenerating && aiSummary && /^(无[。.]?|没有[^\n]{0,20}|暂无[^\n]{0,20})$/.test(aiSummary.trim())
              const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty
              const resolved = done || isEmpty

              return (
                <div
                  key={dim.key}
                  className={`rounded-lg border transition-all ${
                    resolved && !isEmpty
                      ? isExpanded
                        ? 'bg-white border-stone-200'
                        : 'bg-white border-stone-200 cursor-pointer hover:border-stone-300'
                      : resolved && isEmpty
                        ? 'bg-stone-50 border-stone-200'
                      : isActive
                        ? 'bg-stone-50 border-stone-200'
                        : 'border-stone-100'
                  }`}
                >
                  <div
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${resolved && !isEmpty ? 'cursor-pointer' : ''}`}
                    onClick={() => {
                      if (!resolved || isEmpty) return
                      setExpandedDimensions(prev => {
                        const next = new Set(prev)
                        isExpanded ? next.delete(dim.key) : next.add(dim.key)
                        return next
                      })
                    }}
                  >
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold ${
                      resolved && !isEmpty ? 'bg-stone-900 text-white'
                      : resolved && isEmpty ? 'bg-stone-300 text-white'
                      : isActive ? 'bg-stone-100 text-stone-600'
                      : 'bg-stone-100 text-stone-300'
                    }`}>
                      {resolved && !isEmpty ? '✓' : resolved && isEmpty ? '—' : isActive ? '·' : '·'}
                    </span>
                    <span className={`flex-1 text-[13px] ${
                      resolved && !isEmpty ? 'text-stone-700 font-medium'
                      : resolved && isEmpty ? 'text-stone-400 line-through decoration-stone-300'
                      : isActive ? 'text-stone-700'
                      : 'text-stone-300'
                    }`}>
                      {dim.label}
                    </span>
                    {resolved && !isEmpty && (
                      isGenerating ? (
                        <span className="text-[10px] text-stone-400 animate-pulse">…</span>
                      ) : (() => {
                        const sectionCount = aiSummary
                          ? aiSummary.split('\n').filter(l => l.startsWith('# ')).length
                          : 0
                        const isExpDim = ['project', 'internship', 'research'].includes(dim.key)
                        return (
                          <div className="flex items-center gap-1.5">
                            {isExpDim && sectionCount >= 1 && (
                              <span className="text-[10px] font-medium text-stone-500 bg-stone-100 px-1.5 py-0.5 rounded-full border border-stone-200">
                                {sectionCount} 段
                              </span>
                            )}
                            <span className={`text-[10px] text-stone-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                          </div>
                        )
                      })()
                    )}
                    {resolved && isEmpty && (
                      <span className="text-[10px] text-stone-400 bg-stone-200 px-1.5 py-0.5 rounded-full font-medium">无对应经历</span>
                    )}
                    {isActive && (
                      <span className="text-[10px] text-stone-500 animate-pulse">进行中</span>
                    )}
                  </div>

                  {done && !isEmpty && isExpanded && (
                    <div className="px-3 pb-3 pt-0 border-t border-stone-100">
                      {isGenerating ? (
                        <div className="flex items-center gap-2 py-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-pulse shrink-0" />
                          <p className="text-[11px] text-stone-400">整理中…</p>
                        </div>
                      ) : aiSummary ? (
                        <div className="pt-2">
                          {(() => {
                            const lines = aiSummary.split('\n').filter(l => l.trim())
                            const sections: { title: string | null; bullets: string[] }[] = []
                            let cur: { title: string | null; bullets: string[] } = { title: null, bullets: [] }
                            for (const line of lines) {
                              if (line.startsWith('# ')) {
                                if (cur.bullets.length > 0 || cur.title !== null) sections.push(cur)
                                cur = { title: line.slice(2).trim(), bullets: [] }
                              } else {
                                const text = line.replace(/^[·•]\s*/, '').trim()
                                if (text) cur.bullets.push(text)
                              }
                            }
                            if (cur.bullets.length > 0 || cur.title !== null) sections.push(cur)
                            const isMulti = sections.length > 1 && sections[0].title !== null
                            return (
                              <>
                                <div className={isMulti ? 'space-y-2.5' : 'space-y-1.5'}>
                                  {sections.map((sec, si) => {
                                    const secLocIdx = sec.title ? getExpStart(sec.title) : -1
                                    const effectiveLocIdx = (isMulti && secLocIdx === -1 && si === 0)
                                      ? getDimStart(dim.key)
                                      : secLocIdx
                                    return (
                                      <div key={si}>
                                        {sec.title && (
                                          <p className="text-[10px] font-semibold text-stone-600 mb-1">{sec.title}</p>
                                        )}
                                        <div className="space-y-1">
                                          {sec.bullets.map((b, bi) => (
                                            <div key={bi} className="flex gap-2 items-start">
                                              <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0 mt-1.5" />
                                              <p className="text-[11px] text-stone-500 leading-snug">{b}</p>
                                            </div>
                                          ))}
                                        </div>
                                        {isMulti && effectiveLocIdx >= 0 && (
                                          <button
                                            className="mt-1.5 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                                            onClick={(e) => {
                                              e.stopPropagation()
                                              document.getElementById(`msg-${effectiveLocIdx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                            }}
                                          >
                                            定位到对话 ↑
                                          </button>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                                {!isMulti && getDimStart(dim.key) >= 0 && (
                                  <button
                                    className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const idx = getDimStart(dim.key)
                                      if (idx < 0) return
                                      document.getElementById(`msg-${idx}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                    }}
                                  >
                                    定位到对话 ↑
                                  </button>
                                )}
                              </>
                            )
                          })()}
                        </div>
                      ) : (
                        <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                      )}
                    </div>
                  )}

                  {isActive && aiSummary && (
                    <div className="px-3 pb-2.5 pt-0 border-t border-stone-100">
                      {(() => {
                        const firstValue = aiSummary.split('\n').map(l => {
                          const s = l.indexOf('：')
                          return s >= 0 ? l.slice(s + 1).trim() : l.replace(/^[·•]\s*/, '').trim()
                        }).find(v => v && v !== '未提及')
                        return <p className="text-[11px] text-stone-500/70 leading-snug pt-1.5">{firstValue ?? ''}</p>
                      })()}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </aside>

      {/* ── Persona editor modal ──────────────────────────────────────────────── */}
      {showPersonaModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6" onClick={() => setShowPersonaModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg flex flex-col" style={{ maxHeight: '80vh' }} onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 shrink-0">
              <p className="text-sm font-semibold text-stone-700">学生 Persona</p>
              <button onClick={() => setShowPersonaModal(false)} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
            </div>
            <textarea
              value={simPersona}
              onChange={e => setSimPersona(e.target.value)}
              className="flex-1 p-4 text-xs text-stone-700 leading-relaxed resize-none focus:outline-none"
              placeholder="输入学生的 system prompt…"
            />
            <div className="px-4 py-3 border-t border-stone-200 flex items-center justify-between shrink-0">
              <button onClick={() => setSimPersona(DEFAULT_PERSONA)} className="text-xs text-stone-400 hover:text-stone-600 transition-colors">重置默认</button>
              <button onClick={() => setShowPersonaModal(false)} className="bg-stone-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-stone-700 transition-colors">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* ── User info modal ───────────────────────────────────────────────────── */}
      {showQuickInfoModal && (
        <div className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-6" onClick={() => setShowQuickInfoModal(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200">
              <p className="text-sm font-semibold text-stone-700">学生基本信息</p>
              <button onClick={() => setShowQuickInfoModal(false)} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
            </div>
            <div className="p-4 space-y-3">
              <p className="text-[11px] text-stone-400">填写后模拟用户在 onboarding 填写了基本信息但未上传 CV 的场景。空字段不传。</p>
              {([
                { key: 'school', label: '就读院校', placeholder: '北京大学' },
                { key: 'major', label: '就读专业', placeholder: '信息管理与信息系统' },
                { key: 'gpa', label: 'GPA', placeholder: '3.6/4.0' },
                { key: 'targetSchool', label: '目标院校', placeholder: 'Carnegie Mellon University' },
                { key: 'targetMajor', label: '申请专业', placeholder: 'MSML' },
                { key: 'degree', label: '申请学位', placeholder: 'MS' },
              ] as const).map(({ key, label, placeholder }) => (
                <div key={key}>
                  <label className="text-[10px] text-stone-400 block mb-1">{label}</label>
                  <input
                    type="text"
                    value={simQuickInfo[key]}
                    onChange={e => setSimQuickInfo(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={placeholder}
                    className="w-full text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-md px-3 py-1.5 focus:outline-none focus:border-stone-400"
                  />
                </div>
              ))}
            </div>
            <div className="px-4 pb-3 border-b border-stone-100">
              <p className="text-[11px] font-medium text-stone-500 mb-2">经历情况（填段数，0 表示无）</p>
              {([
                { key: 'internship' as const, label: '实习经历段数' },
                { key: 'research' as const, label: '科研经历段数' },
              ]).map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between py-1.5">
                  <span className="text-xs text-stone-600">{label}</span>
                  <input
                    type="number"
                    min={0}
                    max={9}
                    value={simExperiences[key]}
                    onChange={e => setSimExperiences(prev => ({ ...prev, [key]: Math.max(0, parseInt(e.target.value) || 0) }))}
                    className="w-14 text-xs text-center text-stone-700 bg-stone-50 border border-stone-200 rounded-md px-2 py-1 focus:outline-none focus:border-stone-400"
                  />
                </div>
              ))}
            </div>
            <div className="px-4 py-3 flex items-center justify-between">
              <button
                onClick={() => {
                  setSimQuickInfo({ school: '', major: '', gpa: '', targetSchool: '', targetMajor: '', degree: '' })
                  setSimExperiences({ internship: 0, research: 0 })
                }}
                className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
              >
                重置
              </button>
              <button
                onClick={() => {
                  setShowQuickInfoModal(false)
                  if (quickInfoModalIsNewUser.current) {
                    quickInfoModalIsNewUser.current = false
                    const qi = simQuickInfo
                    if (Object.values(qi).some(v => v.trim())) {
                      setQuickInfo(qi)
                    }
                    // Start sim immediately; triggerStudentReply fires via isThinking watcher after AI responds
                    simRunningRef.current = true
                    setSimRunning(true)
                    callAI([])
                  }
                }}
                className="bg-stone-800 text-white text-xs px-4 py-2 rounded-lg hover:bg-stone-700 transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
