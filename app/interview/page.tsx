'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { INTERVIEW_DIMENSIONS } from '@/lib/types'
import type { Message } from '@/lib/types'
import { Mascot } from '@/components/Mascot'

/**
 * Scan the full message history for [COVERED:*] and [EMPTY:*] tags that may
 * have been missed by real-time parsing (e.g. the AI omitted the tag in that
 * turn, or the window was already scrolled past). Updates the store immediately.
 * Returns the full set of covered dims after the scan.
 */
function recoverMissedTagsFromHistory(msgs: Message[]): string[] {
  const store = useAppStore.getState()
  const covered: string[] = []
  const empty: string[] = []

  for (const msg of msgs) {
    if (msg.role !== 'assistant') continue
    const c = msg.rawContent ?? msg.content  // rawContent preserves [COVERED:] / [EMPTY:] tags
    const covMatches = [...c.matchAll(/\[COVERED[：:]\s*([^\]]+)\]/gi)]
    covMatches.forEach(m =>
      m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(d => {
        if (!covered.includes(d)) covered.push(d)
      })
    )
    const emtMatches = [...c.matchAll(/\[EMPTY[：:]\s*([^\]]+)\]/gi)]
    emtMatches.forEach(m =>
      m[1].split(',').map(s => s.trim()).filter(Boolean).forEach(d => {
        if (!empty.includes(d)) empty.push(d)
      })
    )
  }

  const nowCovered = store.coveredDimensions
  const newCovered = covered.filter(d => !nowCovered.includes(d))
  if (newCovered.length > 0) store.setCoveredDimensions(newCovered)

  const nowEmpty = store.emptyDimensions
  const newEmpty = empty.filter(d => !nowEmpty.includes(d))
  if (newEmpty.length > 0) {
    newEmpty.forEach(d => store.markDimensionEmpty(d))
    store.setCoveredDimensions(newEmpty)
  }

  return Array.from(new Set([...nowCovered, ...newCovered, ...newEmpty]))
}

/**
 * Find the index (in msgs) of the first AI message that *asks* about a dimension.
 * Primary mechanism: [ASKING:dim] marker.
 * Fallback: keyword match — but only if the message contains a `？` or `?`,
 * which filters out intro mentions like "我们待会儿会聊到实习经历".
 */
function findDimStartInHistory(dim: string, msgs: Message[]): number {
  // Primary: explicit [ASKING:dim] marker
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const raw = (m as Message & { rawContent?: string }).rawContent ?? m.content
    if (new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i').test(raw)) return i
  }
  // Fallback: keyword match + must contain a question mark (actual question, not a mention)
  const KEYWORD_MAP: Record<string, RegExp> = {
    academic:   /学习经历|本科|在校|GPA|专业课/i,
    project:    /项目经历|做过.*项目|参与.*项目|课外.*活动|大作业|课程设计/i,
    internship: /实习经历|实习.*过|在.*实习|工作.*经历/i,
    research:   /科研经历|做过.*科研|参与.*研究|实验室/i,
    motivation: /申请动机|为什么.*申请|为什么.*出国|申请.*原因/i,
    plan:       /未来规划|职业规划|未来.*规划|毕业[后之]|毕业.*[想计打发]|职业.*目标|未来.*打算|未来.*方向|以后.*[想打]|将来.*[想打]|长期.*目标|短期.*计划|希望.*发展|领域.*发展|发展方向|设想.*方向/i,
    personal:   /个人特质|你.*特质|特别擅长|你.*擅长|让你成长|你.*成长|印象深刻|你.*特点|你自己有没有|你有没有.*感觉/i,
  }
  const kw = KEYWORD_MAP[dim]
  if (!kw) return -1
  // Build per-dim keyword patterns for the "other dimensions" check
  const OTHER_DIM_PATTERNS = Object.entries(KEYWORD_MAP)
    .filter(([k]) => k !== dim)
    .map(([, re]) => re)
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    if (!kw.test(m.content) || !/[？?]/.test(m.content)) continue
    // Skip if 3+ *other* dimension topics are mentioned — that's an intro/overview, not a focused question.
    // Transition messages mention at most 1-2 other dims ("X聊完了，来聊Y"), which is fine.
    const otherDimCount = OTHER_DIM_PATTERNS.filter(re => re.test(m.content)).length
    if (otherDimCount >= 3) continue
    return i
  }
  return -1
}

/**
 * Detect dimension coverage via the /api/detect-dimensions endpoint.
 * Always sends the FULL message history so that:
 *  - parseTagsFromConversation can find [ASKING/COVERED/EMPTY] tags from any
 *    point in the conversation, not just a recent window.
 *  - AI analysis windows are extracted correctly even for early dimensions
 *    (research, motivation, plan) that may be 30-60+ messages in the past.
 */
async function detectCoverageWithAI(msgs: Message[]) {
  if (useAppStore.getState().coveredDimensions.length >= 7) return
  if (!msgs.some(m => m.role === 'user')) return

  try {
    const res = await fetch('/api/detect-dimensions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: msgs,          // full history — parseTagsFromConversation is O(n) regex, fast
        alreadyCovered: useAppStore.getState().coveredDimensions,
      }),
    })
    if (!res.ok) return
    const data = await res.json()

    if (data.coveredDimensions?.length > 0) {
      const nowCovered = useAppStore.getState().coveredDimensions
      // For strict dims (research/motivation/plan/personal):
      // - conf >= 0.6 AND [ASKING:dim] marker present → AI explicitly opened the topic
      // - conf >= 0.80 without marker → high-confidence window analysis result
      //   (genuine coverage: 0.75–0.90; false-positive from passing mention: 0.3–0.65)
      const STRICT_DIMS = new Set(['research', 'motivation', 'plan', 'personal'])
      const dimMap: Record<string, number> = {}
      if (Array.isArray(data.dimensions)) {
        for (const d of data.dimensions) dimMap[d.key] = d.confidence ?? 0
      }
      const hasAskingMarker = (d: string) =>
        msgs.some(m => m.role === 'assistant' &&
          new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(m.rawContent ?? m.content))
      const newDims = (data.coveredDimensions as string[]).filter(d => {
        if (nowCovered.includes(d)) return false
        if (STRICT_DIMS.has(d)) {
          const conf = dimMap[d] ?? 0
          return conf >= 0.80 || (conf >= 0.6 && hasAskingMarker(d))
        }
        return true
      })
      if (newDims.length > 0) {
        useAppStore.getState().setCoveredDimensions(newDims)
      }
    }

    // Mark empty dims — AI analysis may detect empty even when AI forgot [EMPTY:] tag
    if (Array.isArray(data.dimensions)) {
      const store = useAppStore.getState()
      const existing = store.dimensionSummaries
      for (const dim of data.dimensions) {
        if (dim.covered && dim.empty && dim.confidence >= 0.6) {
          if (!store.emptyDimensions.includes(dim.key)) {
            store.markDimensionEmpty(dim.key)
          }
        }
        if (dim.covered && dim.summary && !existing[dim.key]) {
          store.setDimensionSummary(dim.key, dim.summary)
        }
      }
    }
  } catch {
    // fail silently — primary detection via [COVERED:...] tags still works
  }
}


// 从历史对话中推断目标项目信息（兜底：AI 未能输出 [TARGET:] 标记时使用）
// 扫描顾问的回复，看是否有确认目标院校的话语；同时扫描用户消息里的学校/专业/学位关键词
function inferTargetFromMessages(msgs: Message[]) {
  const allText = msgs.map(m => m.content).join(' ')
  const userText = msgs.filter(m => m.role === 'user').map(m => m.content).join(' ')

  // 学位类型 — 只从用户消息中提取，避免匹配 AI 问话里的"硕士"等词
  const degreeMatch = userText.match(/\b(PhD|MS|MA|MBA|MFA|MEng|博士|硕士|master|doctorate)\b/i)
  let degree = ''
  if (degreeMatch) {
    const d = degreeMatch[1].toLowerCase()
    if (d === '博士' || d === 'phd' || d === 'doctorate') degree = 'PhD'
    else if (d === 'mba') degree = 'MBA'
    else degree = 'MS'
  }

  // 专业关键词（从用户消息提取）
  const majorPatterns = [
    /(?:申请|读|学习|专业|major[是为：: ]+)([A-Za-z\s]{3,30}?)(?=[，。,.\s]|$)/i,
    /(computer science|cs|data science|ee|electrical engineering|mechanical engineering|finance|business analytics|information systems)/i,
    /(计算机科学|数据科学|电子工程|机械工程|金融工程|商业分析|信息系统|人工智能|软件工程)/,
  ]
  let major = ''
  for (const p of majorPatterns) {
    const m = userText.match(p)
    if (m) { major = (m[1] || m[0]).trim(); break }
  }

  // 学校名（从全对话提取，通常在顾问的确认性话语或用户回复中）
  const schoolPattern = /(UCLA|USC|NYU|CMU|MIT|Stanford|Columbia|Cornell|UCSD|UIUC|UMich|GT|Gatech|UPenn|Princeton|Harvard|Yale|UW|Purdue|UT Austin|UCSB|UCB|UC Berkeley|北大|清华|复旦|交大|浙大)/gi
  const schoolMatches = Array.from(allText.matchAll(schoolPattern)).map(m => m[1])
  const schools = Array.from(new Set(schoolMatches)).slice(0, 4).join('/')

  if (schools || major || degree) {
    const target = [schools, major, degree].filter(Boolean).join('|')
    if (target) useAppStore.getState().setTargetProgram(target)
  }
}

function parseAIMessage(raw: string): {
  clean: string
  covered: string[]
  empty: string[]
  deferred: string[]
  asking: string[]
  complete: boolean
  target: string | null
} {
  let clean = raw
  let covered: string[] = []
  let empty: string[] = []
  let deferred: string[] = []
  let asking: string[] = []
  let complete = false
  let target: string | null = null

  const targetMatch = clean.match(/\[TARGET[：:]\s*([^\]]*)\]/)
  if (targetMatch) {
    target = targetMatch[1].trim()
    clean = clean.replace(/\[TARGET[：:][^\]]*\]/g, '').trim()
  }
  const coveredMatches = [...clean.matchAll(/\[COVERED[：:]\s*([^\]]*)\]/g)]
  if (coveredMatches.length > 0) {
    covered = coveredMatches.flatMap(m => m[1].split(',').map((s) => s.trim()).filter(Boolean))
    clean = clean.replace(/\[COVERED[：:][^\]]*\]/g, '').trim()
  }
  const emptyMatches = [...clean.matchAll(/\[EMPTY[：:]\s*([^\]]*)\]/g)]
  if (emptyMatches.length > 0) {
    empty = emptyMatches.flatMap(m => m[1].split(',').map((s) => s.trim()).filter(Boolean))
    clean = clean.replace(/\[EMPTY[：:][^\]]*\]/g, '').trim()
  }
  const deferredMatches = [...clean.matchAll(/\[DEFERRED[：:]\s*([^\]]*)\]/g)]
  if (deferredMatches.length > 0) {
    deferred = deferredMatches.flatMap(m => m[1].split(',').map((s) => s.trim()).filter(Boolean))
    clean = clean.replace(/\[DEFERRED[：:][^\]]*\]/g, '').trim()
  }
  const askingMatches = [...clean.matchAll(/\[ASKING[：:]\s*([^\]]*)\]/g)]
  if (askingMatches.length > 0) {
    asking = askingMatches.flatMap(m => m[1].split(',').map((s) => s.trim()).filter(Boolean))
    clean = clean.replace(/\[ASKING[：:][^\]]*\]/g, '').trim()
  }
  if (clean.includes('[INTERVIEW_COMPLETE]')) {
    complete = true
    clean = clean.replace('[INTERVIEW_COMPLETE]', '').trim()
  }
  return { clean, covered, empty, deferred, asking, complete, target }
}


export default function InterviewPage() {
  const router = useRouter()
  const {
    messages,
    interviewComplete,
    coveredDimensions,
    emptyDimensions,
    targetProgram,
    dimensionSummaries,
    activeDimension,
    addMessage,
    updateLastAssistantMessage,
    setInterviewComplete,
    setCoveredDimensions,
    deferDimension,
    setTargetProgram,
    setDimensionSummary,
    setActiveDimension,
    markDimensionEmpty,
    cvText,
    cvAnalysis,
    reset,
  } = useAppStore()

  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [textInput, setTextInput] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [interimText, setInterimText] = useState('')
  const [hasVoiceSupport, setHasVoiceSupport] = useState(false)
  const [generatingSummaries, setGeneratingSummaries] = useState<Record<string, boolean>>({})
  const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set())
  const [isRefreshingDimensions, setIsRefreshingDimensions] = useState(false)

  const messagesRef = useRef<Message[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<unknown>(null)
  const interimRef = useRef('')
  const isCancelledRef = useRef(false)
  const initialized = useRef(false)
  // 记录每个维度上次生成摘要时的消息数，用于判断是否需要中途重新生成
  const summaryGeneratedAtRef = useRef<Record<string, number>>({})

  useEffect(() => { messagesRef.current = messages }, [messages])

  // Auto-scroll to bottom (only when user hasn't manually scrolled up)
  useEffect(() => {
    if (scrollRef.current && !userScrolledRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, streamingText, interviewComplete])

  useEffect(() => {
    const supported =
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
    setHasVoiceSupport(supported)
  }, [])

  useEffect(() => {
    if (initialized.current) return
    initialized.current = true
    if (messages.length === 0) {
      callAI([])
    } else if (!targetProgram) {
      // 已有对话记录但 targetProgram 为空（如 AI 未能输出 [TARGET:] 标记）
      // 尝试从历史对话中提取目标项目信息
      inferTargetFromMessages(messages)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function callAI(msgs: Message[]) {
    setStreamingText('')
    setIsThinking(true)
    addMessage({ role: 'assistant', content: '' })

    try {
      // Always read latest store state to avoid React closure staleness
      const snap = useAppStore.getState()
      // Truncate to last 40 messages to prevent token overflow on long conversations
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
          cvText:             snap.cvText,
          cvAnalysis:         snap.cvAnalysis,
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

      const { clean, covered, empty, deferred, asking, complete, target } = parseAIMessage(fullText)
      updateLastAssistantMessage(clean, fullText)
      setStreamingText('')
      if (target) {
        setTargetProgram(target)
      } else if (!useAppStore.getState().targetProgram) {
        inferTargetFromMessages([...msgs, { role: 'assistant', content: clean }])
      }

      // ── Apply covered/empty tags from this message FIRST ─────────────────────
      // Must happen before the asking-transition check so that a message like
      // [COVERED:research][ASKING:motivation] correctly sees research as covered.
      if (empty.length > 0) {
        empty.forEach(dim => markDimensionEmpty(dim))
        setCoveredDimensions(empty)
      }
      if (covered.length > 0) {
        setCoveredDimensions(covered)
      }

      // ── Personal covered → unconditionally resolve motivation + plan ────────
      // personal is the last dimension; once it's done the interview is over.
      // motivation/plan must have been discussed in some form — force-cover any
      // that are still missing so the completion flow can proceed.
      {
        const s = useAppStore.getState()
        const personalDone = covered.includes('personal') || s.coveredDimensions.includes('personal')
        if (personalDone) {
          const toForce = ['motivation', 'plan'].filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      // ── Dimension transition ──────────────────────────────────────────────────
      deferred.forEach(dim => deferDimension(dim))
      if (asking.length > 0) {
        const prevDim = useAppStore.getState().activeDimension
        if (prevDim && useAppStore.getState().coveredDimensions.includes(prevDim)) {
          generateDimensionSummary(prevDim)
        }
        setActiveDimension(asking[0])
      }

      // ── Build full message list (including this response) ─────────────────────
      // For detection purposes, use rawContent (with tags) where available so that
      // parseTagsFromConversation can find [ASKING/COVERED/EMPTY] anchors.
      const msgsForDetection: Message[] = [
        ...msgs.map(m => ({ role: m.role, content: m.rawContent ?? m.content } as Message)),
        { role: 'assistant', content: fullText },
      ]
      const msgsWithResponse = msgsForDetection

      // ── Synchronously recover any tags missed in earlier turns ────────────────
      // Must run BEFORE the complete-check so recovered dims are visible.
      recoverMissedTagsFromHistory(msgsWithResponse)

      // ── Background AI detection (deeper analysis of uncovered dims) ───────────
      detectCoverageWithAI(msgsWithResponse) // fire-and-forget

      // ── Mid-deep-dive summary refresh (every 6 new messages) ─────────────────
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

        // ── Force-cover dims that were asked + user replied but AI forgot [COVERED:] ──
        // When [INTERVIEW_COMPLETE] fires, trust that the interview is done.
        // Any dim with an [ASKING:dim] marker and at least one subsequent user reply
        // is considered discussed — mark it covered so the interview can fully complete.
        {
          const s = useAppStore.getState()
          const toForce = ALL_DIMENSIONS.filter(d => {
            if (s.coveredDimensions.includes(d)) return false
            const askIdx = msgsWithResponse.findIndex(m =>
              m.role === 'assistant' &&
              new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(m.rawContent ?? m.content)
            )
            if (askIdx === -1) return false
            // Confirm user replied after the asking message
            return msgsWithResponse.slice(askIdx + 1).some(m => m.role === 'user')
          })
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }

        const s2 = useAppStore.getState()
        const coveredSet = new Set(s2.coveredDimensions)
        const allCovered = ALL_DIMENSIONS.every(d => coveredSet.has(d))
        // CV users: complete if all non-exp dims covered + every exp dim is covered or empty
        const NON_EXP = ['motivation', 'plan', 'personal']
        const EXP = ['academic', 'project', 'internship', 'research']
        const cvComplete = !!s2.cvText &&
          NON_EXP.every(d => coveredSet.has(d)) &&
          EXP.every(d => coveredSet.has(d) || s2.emptyDimensions.includes(d))
        if (allCovered || cvComplete) {
          setInterviewComplete(true)
          generateAllSummaries(ALL_DIMENSIONS)
        }
        // If still not all covered: background detectCoverageWithAI will fill gaps;
        // the useEffect below triggers completion once all dims are detected.
      }
    } catch (err) {
      console.error(err)
      updateLastAssistantMessage('抱歉，出了点问题，请重试。')
    } finally {
      setIsThinking(false)
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

      // ── Local keyword fallback ─────────────────────────────────────────────
      // If AI analysis still missed a dim, scan the conversation directly:
      // if the advisor asked a matching question AND the user replied with > 8 chars,
      // treat the dim as covered. This is the last-resort for dims where the AI
      // forgot both [ASKING:] and [COVERED:] markers.
      const QUESTION_KW: Record<string, RegExp> = {
        motivation: /为什么.*申请|为什么.*出国|申请.*动机|什么.*促使|驱动你|想来.*读|想出来/i,
        plan:       /毕业.*想|未来.*打算|职业.*目标|未来规划|毕业后|长期.*目标|短期.*计划/i,
        personal:   /印象深刻|让你成长|成长.*经历|改变.*想法|你.*特点|自我.*认知|你.*是.*怎样.*人/i,
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

      // ── personal covered → unconditionally resolve motivation + plan ───────
      {
        const s = useAppStore.getState()
        if (s.coveredDimensions.includes('personal')) {
          const toForce = ['motivation', 'plan'].filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      // ── Wrap-up detection: AI said farewell but forgot [INTERVIEW_COMPLETE] ─
      // If the last assistant message contains the closing formula the prompt
      // mandates ("接下来系统会帮你提炼叙事方向"), and the user has ≥8 replies,
      // the interview is objectively over — force-cover any remaining dims.
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

      // Refresh summaries for all currently covered dims (exp dims in sequence)
      await generateAllSummaries(useAppStore.getState().coveredDimensions)
    } finally {
      setIsRefreshingDimensions(false)
    }
  }

  function handleSkip() {
    const dim = useAppStore.getState().activeDimension
    if (!dim || isThinking) return
    markDimensionEmpty(dim)
    setCoveredDimensions([dim])
    // Let AI continue with updated state (next missing dim will be first in list)
    callAI(messagesRef.current)
  }

  // Voice
  const startListening = useCallback(() => {
    if (isThinking || isListening) return
    isCancelledRef.current = false
    setInterimText('')
    interimRef.current = ''
    setIsListening(true)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return

    const recognition = new SR()
    recognition.lang = 'zh-CN'
    recognition.continuous = false
    recognition.interimResults = true
    recognitionRef.current = recognition

    recognition.onresult = (event: { resultIndex: number; results: { [key: number]: { isFinal: boolean; [key: number]: { transcript: string } } } }) => {
      let text = ''
      for (let i = event.resultIndex; i < (event.results as unknown as unknown[]).length; i++) {
        text += event.results[i][0].transcript
      }
      interimRef.current = text
      setInterimText(text)
    }

    recognition.onend = () => {
      const text = interimRef.current
      interimRef.current = ''
      setInterimText('')
      setIsListening(false)
      if (!isCancelledRef.current && text.trim()) {
        handleSend(text.trim())
      }
    }

    recognition.onerror = () => {
      setIsListening(false)
      setInterimText('')
    }

    recognition.start()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isThinking, isListening])

  function handleMicClick() {
    if (isListening) {
      isCancelledRef.current = true
      ;(recognitionRef.current as { stop: () => void } | null)?.stop()
    } else {
      startListening()
    }
  }


  const EXP_DIMS = ['project', 'internship', 'research']

  // 生成维度AI总结的函数（总是生成高质量版本，覆盖 detect-dimensions 的简短占位摘要）
  async function generateDimensionSummary(dimension: string) {
    if (generatingSummaries[dimension]) {
      return // 已在生成中，跳过
    }

    setGeneratingSummaries(prev => ({ ...prev, [dimension]: true }))
    // 记录本次生成时的消息数，供中途更新节流使用
    summaryGeneratedAtRef.current[dimension] = useAppStore.getState().messages.length

    try {
      // For experience dims, pass sibling summaries so AI knows which experiences
      // are already claimed by another dimension and won't duplicate them.
      const relatedSummaries: Record<string, string> = {}
      if (EXP_DIMS.includes(dimension)) {
        const allSummaries = useAppStore.getState().dimensionSummaries
        for (const other of EXP_DIMS) {
          if (other !== dimension && allSummaries[other]) {
            relatedSummaries[other] = allSummaries[other]
          }
        }
      }

      // Send full conversation so the AI has all context to extract specific details
      const { cvText: cv, cvAnalysis: cvA } = useAppStore.getState()
      const res = await fetch('/api/summarize-dimension', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dimension,
          messages: useAppStore.getState().messages,
          relatedSummaries,
          cvText: cv || '',
          cvAnalysis: cvA || '',
        }),
      })
      
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      
      const data = await res.json()
      if (data.summary) {
        setDimensionSummary(dimension, data.summary)
        // Invalidate step1Summaries so the highlights page regenerates fresh content.
        // Use '' (falsy) rather than delete so the store shape stays consistent.
        useAppStore.getState().setStep1Summary(dimension, '')
      }
    } catch (error) {
      console.error(`生成维度"${dimension}"总结失败:`, error)
      // 失败时使用备用总结
      const fallbackSummary = `已了解用户的${INTERVIEW_DIMENSIONS.find(d => d.key === dimension)?.label || dimension}相关信息`
      setDimensionSummary(dimension, fallbackSummary)
    } finally {
      setGeneratingSummaries(prev => ({ ...prev, [dimension]: false }))
    }
  }
  
  // 生成一批维度的总结：非经历维度并行，经历维度按 project→internship→research 顺序，
  // 确保后生成的能读到先生成的摘要，避免同一段经历出现在多个维度。
  async function generateAllSummaries(dims: string[]) {
    const nonExp = dims.filter(d => !EXP_DIMS.includes(d))
    const exp = EXP_DIMS.filter(d => dims.includes(d))
    nonExp.forEach(dim => generateDimensionSummary(dim))
    for (const dim of exp) {
      await generateDimensionSummary(dim)
    }
  }

  // 当维度被标记为完成时，自动生成AI总结
  useEffect(() => {
    const pending = coveredDimensions.filter(dim => !dimensionSummaries[dim] && !generatingSummaries[dim])
    if (pending.length > 0) generateAllSummaries(pending)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, dimensionSummaries, generatingSummaries])

  // Auto-complete when all dimensions become covered via background detection
  // (handles the case where AI prematurely emits [INTERVIEW_COMPLETE] before
  //  all dims are tagged, then background AI detection fills in the gaps)
  useEffect(() => {
    if (interviewComplete) return
    const ALL_DIMENSIONS = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']
    if (ALL_DIMENSIONS.every(d => coveredDimensions.includes(d))) {
      setInterviewComplete(true)
      generateAllSummaries(ALL_DIMENSIONS)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions])
  
  const roundCount = messages.filter((m) => m.role === 'user').length
  // Render messages - for the last assistant message during streaming, show streamingText
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
              <span>→</span>
              <Link href="/highlights" className="hover:text-stone-600 transition-colors">人设方向</Link>
              <span>→</span>
              <Link href="/framework" className="hover:text-stone-600 transition-colors">框架</Link>
              <span>→</span>
              <Link href="/editor" className="hover:text-stone-600 transition-colors">编辑</Link>
            </div>
          </div>
          <button
            onClick={() => {
              if (confirm('重置采访？所有对话记录将清除。')) {
                reset()
                try { localStorage.removeItem('essay-assistant-store') } catch {}
                initialized.current = false
                window.location.reload()
              }
            }}
            className="text-xs text-stone-400 hover:text-stone-600 transition-colors"
          >
            重新开始
          </button>
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
                {/* Avatar */}
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

                {/* Bubble */}
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

            {/* Completion banner */}
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
            {/* Skip current topic */}
            {activeDimension && !interviewComplete && !isThinking && (
              <div className="flex justify-end mb-2">
                <button
                  onClick={handleSkip}
                  className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors"
                >
                  跳过此话题 →
                </button>
              </div>
            )}
            {/* Voice interim text */}
            {isListening && (
              <div className="mb-2 px-4 py-2 bg-white border border-stone-200 rounded-xl text-sm text-stone-600">
                <span className="text-red-400 mr-2">●</span>
                {interimText || <span className="text-stone-400 italic">正在聆听…</span>}
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
                disabled={isThinking || isListening}
                rows={1}
                className="flex-1 bg-transparent text-sm text-stone-800 placeholder-stone-400 resize-none focus:outline-none disabled:opacity-50 py-1.5 px-1"
                style={{ minHeight: '36px', maxHeight: '160px' }}
              />
              <div className="flex items-center gap-1.5 shrink-0 pb-1">
                {hasVoiceSupport && (
                  <button
                    onClick={handleMicClick}
                    disabled={isThinking}
                    title={isListening ? '停止录音' : '语音输入'}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-40 ${
                      isListening
                        ? 'bg-red-500 text-white scale-105'
                        : 'text-stone-400 hover:text-stone-600 hover:bg-stone-100'
                    }`}
                  >
                    {isListening ? '⏹' : '🎙️'}
                  </button>
                )}
                <button
                  onClick={() => handleSend(textInput)}
                  disabled={isThinking || isListening || !textInput.trim()}
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
            <Mascot size={36} mood={isThinking ? 'thinking' : 'idle'} className="shrink-0" />
            <div>
              <div className="text-stone-800 font-semibold text-sm">Omi</div>
              <div className="text-stone-400 text-xs">AI 留学顾问精灵</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className={`w-1.5 h-1.5 rounded-full ${interviewComplete ? 'bg-stone-400' : isThinking ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                <span className={`text-xs ${interviewComplete ? 'text-stone-600' : isThinking ? 'text-amber-600' : 'text-emerald-600'}`}>
                  {interviewComplete ? '采访完成 ✓' : isThinking ? '思考中…' : '采访进行中'}
                </span>
              </div>
            </div>
          </div>

          {/* Target program */}
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
          ) : (
            <div className="bg-white border border-stone-100 rounded-lg px-3 py-2 mb-2">
              <p className="text-[10px] text-stone-300 italic">了解目标院校中…</p>
            </div>
          )}

          <div className="text-xs text-stone-400 text-center">
            已对话 <span className="text-stone-600 font-semibold">{roundCount}</span> 轮
          </div>
        </div>

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

            {/* CV user: per-experience outline + non-exp dim summaries */}
            {cvText && (() => {
              // Parse cvAnalysis into entries
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

              // Build a flat map: normalized section title -> { bullets, dimKey }
              // from all exp dimension summaries (project/internship/research use # sections;
              // academic is flat bullets under no header)
              const EXP_SUM_DIMS = ['academic', 'project', 'internship', 'research']
              type SecData = { bullets: string[]; dimKey: string }
              const sectionMap = new Map<string, SecData>()

              for (const dk of EXP_SUM_DIMS) {
                const sumText = dimensionSummaries[dk]
                if (!sumText) continue
                if (dk === 'academic') {
                  // Flat bullets — register under a sentinel key; matched via entry name fallback
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

              // Normalize: lowercase, strip spaces + common punctuation (quotes, brackets, etc.)
              function normStr(s: string) {
                return s.toLowerCase().replace(/[\s""''「」【】《》()（）\-_·•,，.。]/g, '')
              }

              // Find best matching section for an experience entry name
              function findSection(name: string): SecData | null {
                const norm = normStr(name)
                // Exact
                if (sectionMap.has(norm)) return sectionMap.get(norm)!
                // Substring
                for (const [key, data] of sectionMap) {
                  if (key === '__academic__') continue
                  if (norm.includes(key) || key.includes(norm)) return data
                }
                // Partial character overlap (≥ 60% of shorter string)
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

              const EXP_DIMS = ['academic', 'project', 'internship', 'research']
              const NON_EXP_DIMS = INTERVIEW_DIMENSIONS.filter(d => !EXP_DIMS.includes(d.key))
              const anyExpGenerating = EXP_DIMS.some(d => generatingSummaries[d])

              return (
                <>
                  {/* Outline card — each entry expandable to show its AI summary */}
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
                                        <p className="text-[11px] text-stone-500 leading-snug">{b.length > 45 ? b.slice(0, 45) + '…' : b}</p>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      }) : (
                        <p className="text-[11px] text-stone-300 italic px-3 py-2">访谈按简历大纲进行</p>
                      )}
                    </div>
                  </div>

                  {/* Non-exp dims: motivation / plan / personal with full summary */}
                  {NON_EXP_DIMS.map((dim) => {
                    const done = coveredDimensions.includes(dim.key)
                    const isActive = !done && activeDimension === dim.key
                    const isGenerating = generatingSummaries[dim.key]
                    const aiSummary = dimensionSummaries[dim.key]
                    const isExpanded = expandedDimensions.has(dim.key)
                    const summaryIsEmpty = !isGenerating && aiSummary && /^无[。.]?$/.test(aiSummary.trim())
                    const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty

                    return (
                      <div
                        key={dim.key}
                        className={`rounded-lg border transition-all ${
                          done && !isEmpty
                            ? isExpanded ? 'bg-white border-stone-200' : 'bg-white border-stone-200 cursor-pointer hover:border-stone-300'
                            : done && isEmpty ? 'bg-stone-50 border-stone-200'
                            : isActive ? 'bg-stone-50 border-stone-200'
                            : 'border-stone-100'
                        }`}
                      >
                        <div
                          className={`flex items-center gap-2.5 px-3 py-2.5 ${done && !isEmpty ? 'cursor-pointer' : ''}`}
                          onClick={() => {
                            if (!done || isEmpty) return
                            setExpandedDimensions(prev => {
                              const next = new Set(prev)
                              isExpanded ? next.delete(dim.key) : next.add(dim.key)
                              return next
                            })
                          }}
                        >
                          <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold ${
                            done && !isEmpty ? 'bg-stone-900 text-white'
                            : done && isEmpty ? 'bg-stone-300 text-white'
                            : isActive ? 'bg-stone-100 text-stone-600'
                            : 'bg-stone-100 text-stone-300'
                          }`}>
                            {done && !isEmpty ? '✓' : done && isEmpty ? '—' : '·'}
                          </span>
                          <span className={`flex-1 text-[13px] ${
                            done && !isEmpty ? 'text-stone-700 font-medium'
                            : done && isEmpty ? 'text-stone-400 line-through decoration-stone-300'
                            : isActive ? 'text-stone-700'
                            : 'text-stone-300'
                          }`}>{dim.label}</span>
                          {done && !isEmpty && (
                            isGenerating
                              ? <span className="text-[10px] text-stone-400 animate-pulse">…</span>
                              : <span className={`text-[10px] text-stone-400 transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                          )}
                          {done && isEmpty && <span className="text-[10px] text-stone-400 bg-stone-200 px-1.5 py-0.5 rounded-full font-medium">无</span>}
                          {isActive && <span className="text-[10px] text-stone-500 animate-pulse">进行中</span>}
                        </div>
                        {done && !isEmpty && isExpanded && (
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
                                    <p className="text-[11px] text-stone-500 leading-snug">{b.length > 45 ? b.slice(0, 45) + '…' : b}</p>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                            )}
                            {findDimStartInHistory(dim.key, messages) >= 0 && (
                              <button
                                className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  const idx = findDimStartInHistory(dim.key, messages)
                                  if (idx < 0) return
                                  const el = document.getElementById(`msg-${idx}`)
                                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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

            {/* No-CV user: original 7-dim cards */}
            {!cvText && INTERVIEW_DIMENSIONS.map((dim) => {
              const done = coveredDimensions.includes(dim.key)
              const isActive = !done && activeDimension === dim.key
              const isGenerating = generatingSummaries[dim.key]
              const aiSummary = dimensionSummaries[dim.key]
              const isExpanded = expandedDimensions.has(dim.key)
              // Treat as empty if [EMPTY:dim] was emitted, OR if the generated summary is just "无"
              const summaryIsEmpty = !isGenerating && aiSummary && /^无[。.]?$/.test(aiSummary.trim())
              const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty

              return (
                <div
                  key={dim.key}
                  className={`rounded-lg border transition-all ${
                    done && !isEmpty
                      ? isExpanded
                        ? 'bg-white border-stone-200'
                        : 'bg-white border-stone-200 cursor-pointer hover:border-stone-300'
                      : done && isEmpty
                        ? 'bg-stone-50 border-stone-200'
                      : isActive
                        ? 'bg-stone-50 border-stone-200'
                        : 'border-stone-100'
                  }`}
                >
                  {/* Card header */}
                  <div
                    className={`flex items-center gap-2.5 px-3 py-2.5 ${done && !isEmpty ? 'cursor-pointer' : ''}`}
                    onClick={() => {
                      if (!done || isEmpty) return
                      setExpandedDimensions(prev => {
                        const next = new Set(prev)
                        isExpanded ? next.delete(dim.key) : next.add(dim.key)
                        return next
                      })
                    }}
                  >
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold ${
                      done && !isEmpty ? 'bg-stone-900 text-white'
                      : done && isEmpty ? 'bg-stone-300 text-white'
                      : isActive ? 'bg-stone-100 text-stone-600'
                      : 'bg-stone-100 text-stone-300'
                    }`}>
                      {done && !isEmpty ? '✓' : done && isEmpty ? '—' : isActive ? '·' : '·'}
                    </span>
                    <span className={`flex-1 text-[13px] ${
                      done && !isEmpty ? 'text-stone-700 font-medium'
                      : done && isEmpty ? 'text-stone-400 line-through decoration-stone-300'
                      : isActive ? 'text-stone-700'
                      : 'text-stone-300'
                    }`}>
                      {dim.label}
                    </span>
                    {done && !isEmpty && (
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
                    {done && isEmpty && (
                      <span className="text-[10px] text-stone-400 bg-stone-200 px-1.5 py-0.5 rounded-full font-medium">无对应经历</span>
                    )}
                    {isActive && (
                      <span className="text-[10px] text-stone-500 animate-pulse">进行中</span>
                    )}
                  </div>

                  {/* Expanded content */}
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
                            // Parse into sections: lines starting with '# ' are headers
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
                              <div className={isMulti ? 'space-y-2.5' : 'space-y-1.5'}>
                                {sections.map((sec, si) => (
                                  <div key={si}>
                                    {sec.title && (
                                      <p className="text-[10px] font-semibold text-stone-600 mb-1">{sec.title}</p>
                                    )}
                                    <div className="space-y-1">
                                      {sec.bullets.map((b, bi) => (
                                        <div key={bi} className="flex gap-2 items-start">
                                          <span className="w-1 h-1 rounded-full bg-stone-300 shrink-0 mt-1.5" />
                                          <p className="text-[11px] text-stone-500 leading-snug">{b.length > 40 ? b.slice(0, 40) + '…' : b}</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )
                          })()}
                        </div>
                      ) : (
                        <p className="text-[11px] text-stone-300 italic pt-2">暂无记录</p>
                      )}
                      {findDimStartInHistory(dim.key, messages) >= 0 && (
                        <button
                          className="mt-2 text-[10px] text-stone-400 hover:text-stone-600 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation()
                            const idx = findDimStartInHistory(dim.key, messages)
                            if (idx < 0) return
                            const el = document.getElementById(`msg-${idx}`)
                            el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }}
                        >
                          定位到对话 ↑
                        </button>
                      )}
                    </div>
                  )}

                  {/* Live preview for active dim */}
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
    </div>
  )
}
