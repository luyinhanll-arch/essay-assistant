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

export default function InterviewPage() {
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
  } = useAppStore()

  const [isThinking, setIsThinking] = useState(false)
  const isThinkingRef = useRef(false)
  const [streamingText, setStreamingText] = useState('')
  const [textInput, setTextInput] = useState('')

  const [generatingSummaries, setGeneratingSummaries] = useState<Record<string, boolean>>({})
  const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set())
  const [isRefreshingDimensions, setIsRefreshingDimensions] = useState(false)


  const DIM_ORDER = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']

  // Core computation without ordering constraint.
  function getDimStartRaw(dim: string): number {
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
    for (let i = Math.max(0, formalStart); i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      const raw = (m as Message & { rawContent?: string }).rawContent ?? m.content
      if (new RegExp(`\\[(ASKING|COVERED)[：:]\\s*${dim}\\]`, 'i').test(raw)) return i
    }
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

  // Public wrapper: enforces that each dim's position is strictly after the previous dim's.
  // This prevents mis-estimates (especially for personal) from landing before earlier dims.
  function getDimStart(dim: string): number {
    const raw = getDimStartRaw(dim)
    const dimPos = DIM_ORDER.indexOf(dim)
    if (dimPos > 0) {
      // Find the nearest earlier covered/empty dim and ensure we're after it
      for (let p = dimPos - 1; p >= 0; p--) {
        const prevDim = DIM_ORDER[p]
        if (!coveredDimensions.includes(prevDim) && !emptyDimensions.includes(prevDim)) continue
        const prevRaw = getDimStartRaw(prevDim)
        if (prevRaw >= 0 && (raw < 0 || raw <= prevRaw)) {
          // Find the first AI message after prevRaw
          for (let i = prevRaw + 1; i < messages.length; i++) {
            if (messages[i].role === 'assistant') return i
          }
          return prevRaw + 1
        }
        break
      }
    }
    return raw
  }

  // Wrapper: expMessageIndex (recorded when [EXP:name] fires) takes priority over
  // character-overlap scanning in findExpStartInHistory, which is unreliable when
  // multiple experiences share common characters or are mentioned together.
  function getExpStart(expName: string): number {
    // Exact match first
    if (expName in expMessageIndex) return expMessageIndex[expName]
    // Fuzzy match using bigram overlap (more precise than character overlap)
    // to avoid confusion between similarly-named experiences like "信号与系统课程项目" vs "通信原理课程项目"
    const norm = (s: string) => s.toLowerCase().replace(/[\s\-_""''「」【】《》()（）·•,，.。：:]/g, '')
    const normExp = norm(expName)
    const expBigrams = normExp.length >= 2
      ? Array.from({ length: normExp.length - 1 }, (_, k) => normExp.slice(k, k + 2))
      : []
    let bestKey = ''
    let bestScore = 0.7  // require ≥70% bigram overlap to avoid false matches
    for (const key of Object.keys(expMessageIndex)) {
      const normKey = norm(key)
      if (normKey === normExp) return expMessageIndex[key]  // normalized exact match
      if (expBigrams.length === 0) continue
      const keyBigrams = normKey.length >= 2
        ? Array.from({ length: normKey.length - 1 }, (_, k) => normKey.slice(k, k + 2))
        : []
      const matchCount = expBigrams.filter(bg => keyBigrams.includes(bg)).length
      const score = matchCount / Math.max(expBigrams.length, keyBigrams.length)
      if (score > bestScore) { bestScore = score; bestKey = key }
    }
    if (bestKey) return expMessageIndex[bestKey]
    // Final fallback: bigram scan of full message history
    return findExpStartInHistory(expName, messages)
  }

  const messagesRef = useRef<Message[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const userScrolledRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const initialized = useRef(false)
  const pendingCompleteRef = useRef(false)
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
    isThinkingRef.current = true
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

      // ── Record [EXP:name] markers → expMessageIndex ──────────────────────────
      if (exp.length > 0) {
        const msgIdx = useAppStore.getState().messages.length - 1
        exp.forEach(name => {
          if (!(name in useAppStore.getState().expMessageIndex)) {
            setExpMessageIndex(name, msgIdx)
          }
        })
      }

      // ── Apply covered/empty tags from this message FIRST ─────────────────────
      // Must happen before the asking-transition check so that a message like
      // [COVERED:research][ASKING:motivation] correctly sees research as covered.
      if (empty.length > 0) {
        // Guard: [EMPTY:dim] is only valid if [ASKING:dim] has already appeared, OR
        // we're still in the pre-screening phase (before [ASKING:academic] appeared).
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

      // ── Pre-screening fallback: detect from user reply if AI forgot [EMPTY:] ──
      // After the AI asks the pre-screening question and user replies, scan the last
      // user message for negative patterns about internship/research.
      {
        const allMsgs = messagesRef.current
        const formalStarted = allMsgs.some(m =>
          m.role === 'assistant' &&
          /\[ASKING[：:]\s*academic\]/i.test(m.rawContent ?? m.content)
        )
        if (!formalStarted) {
          const s = useAppStore.getState()
          const PRESCREEN_KW = /有没有.*实习|有没有.*科研|正式实习|正式的科研|正式.*实验室|课题组/
          const lastAI = [...allMsgs].reverse().find(m => m.role === 'assistant')
          if (lastAI && PRESCREEN_KW.test(lastAI.rawContent ?? lastAI.content)) {
            const lastUser = msgs[msgs.length - 1]
            if (lastUser?.role === 'user') {
              const u = lastUser.content
              const noInternship = /没有.*实习|实习.*没有|没有正式实习|不.*实习|没.*实习过/.test(u)
              const noResearch = /没有.*科研|科研.*没有|没有正式.*科研|没.*做过.*科研|没.*加入.*实验室|没.*课题/.test(u)
              if (noInternship && !s.emptyDimensions.includes('internship') && !s.coveredDimensions.includes('internship')) {
                s.markDimensionEmpty('internship')
                s.setCoveredDimensions(['internship'])
              }
              if (noResearch && !s.emptyDimensions.includes('research') && !s.coveredDimensions.includes('research')) {
                s.markDimensionEmpty('research')
                s.setCoveredDimensions(['research'])
              }
            }
          }
        }
      }

      if (covered.length > 0) {
        setCoveredDimensions(covered)
        // Force-regenerate summaries for explicitly [COVERED:] dims so that an early
        // pre-screening summary gets replaced with full formal Q&A content.
        // Reset generatingSummaries first so the guard doesn't block re-generation.
        setGeneratingSummaries(prev => {
          const next = { ...prev }
          covered.forEach(d => { next[d] = false })
          return next
        })
        covered.forEach(dim => generateDimensionSummary(dim))
      }

      // ── Cascade re-generation for earlier exp dims ────────────────────────────
      // Experiences mentioned during a later dim (e.g. 公益活动 surfacing during
      // internship probing) are missed by the earlier dim's summary because that
      // summary was generated before those messages existed. Whenever internship or
      // research is newly covered/empty, re-generate all already-resolved exp dims
      // that come before it so their summaries include any newly-surfaced content.
      {
        const EXP_ORDER = ['project', 'internship', 'research'] as const
        const newlyResolved = [...covered, ...empty].filter(d => EXP_DIMS.includes(d))
        if (newlyResolved.length > 0) {
          const minIdx = Math.min(...newlyResolved.map(d => EXP_ORDER.indexOf(d as typeof EXP_ORDER[number])))
          const sSnap = useAppStore.getState()
          const toRefresh = EXP_ORDER.slice(0, minIdx).filter(d =>
            sSnap.coveredDimensions.includes(d) || sSnap.emptyDimensions.includes(d)
          )
          // Re-generate in order so relatedSummaries chain stays correct
          ;(async () => {
            for (const d of toRefresh) {
              await generateDimensionSummary(d)
            }
          })()
        }
      }

      // ── Personal covered → unconditionally resolve motivation + plan ────────
      // personal is the last dimension; once it's done the interview is over.
      // motivation/plan must have been discussed in some form — force-cover any
      // that are still missing so the completion flow can proceed.
      // Guard: only apply if there are ≥6 prior user turns, which means the
      // interview is genuinely late-stage. If personal is wrongly marked early
      // (AI bug), this prevents premature force-covering of motivation/plan.
      {
        const s = useAppStore.getState()
        const priorUserTurns = msgs.filter(m => m.role === 'user').length
        const personalDone = covered.includes('personal') || s.coveredDimensions.includes('personal')
        if (personalDone && priorUserTurns >= 6) {
          const toForce = ['motivation', 'plan'].filter(d => !s.coveredDimensions.includes(d))
          if (toForce.length > 0) s.setCoveredDimensions(toForce)
        }
      }

      // ── Keyword-based activeDimension inference (fallback when AI omits [ASKING:dim]) ──
      // If the AI didn't output [ASKING:dim] but its message clearly asks about a new
      // dimension, inject the inferred dim so downstream NO_EXP_PATTERN / transition
      // logic stays accurate.
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
          // Only infer dims strictly after current active (no backwards jumps),
          // EXCEPT motivation — AI sometimes asks it out of order (after plan).
          if (dimIdx <= curIdx && dim !== 'motivation') continue
          // Must contain keyword AND a question mark (AI is actually asking, not just mentioning)
          if (kw.test(fullText) && /[？?]/.test(fullText) &&
              !sInfer.coveredDimensions.includes(dim) && !sInfer.emptyDimensions.includes(dim)) {
            asking.push(dim)
            break
          }
        }
      }

      // ── Dimension transition ──────────────────────────────────────────────────
      deferred.forEach(dim => deferDimension(dim))
      if (asking.length > 0) {
        const prevDim = useAppStore.getState().activeDimension
        const s = useAppStore.getState()
        if (prevDim && s.coveredDimensions.includes(prevDim)) {
          generateDimensionSummary(prevDim)
        } else if (prevDim && !s.coveredDimensions.includes(prevDim) && !s.emptyDimensions.includes(prevDim)) {
          // AI transitioned away without outputting [COVERED:prevDim].
          // Auto-recover: use dimensionMessageIndex to find where AI first asked about prevDim,
          // then check if user replied with substantial content (>8 chars) after that point.
          // This is more reliable than keyword re-matching the AI's question phrasing.
          const allMsgs = [...msgs, { role: 'assistant' as const, content: fullText }]
          const askStart = s.dimensionMessageIndex[prevDim] ?? -1
          const searchFrom = askStart >= 0 ? askStart : (() => {
            // Fallback: find [ASKING:prevDim] in rawContent
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
        // If this dimension was previously mis-marked as empty, undo it — the AI
        // is explicitly asking about it, so it must have content.
        asking.forEach(d => {
          if (useAppStore.getState().emptyDimensions.includes(d)) removeFromEmpty(d)
        })
        setActiveDimension(asking[0])
        // Record the index of the AI message that first asked about this dimension.
        // Used by findDimStartInHistory as the most reliable source (over keyword scanning).
        const currentMsgIdx = useAppStore.getState().messages.length - 1
        asking.forEach(d => {
          if (!(d in useAppStore.getState().dimensionMessageIndex)) {
            setDimensionMessageIndex(d, currentMsgIdx)
          }
        })
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

        // AI said [INTERVIEW_COMPLETE] → only complete if the message doesn't end with a question
        // (AI sometimes outputs [INTERVIEW_COMPLETE] while still asking a follow-up question)
        const userTurnCount = msgsWithResponse.filter(m => m.role === 'user').length
        const lastAiContent = fullText.replace(/\[[\w:,\s|]+\]/g, '').trim()
        const endsWithQuestion = /[？?]/.test(lastAiContent.slice(-200))
        if (userTurnCount >= 8 && !endsWithQuestion) {
          // Force-cover activeDimension now (useEffect won't run after interviewComplete = true)
          const sNow = useAppStore.getState()
          const activeDim = sNow.activeDimension
          if (activeDim && !sNow.coveredDimensions.includes(activeDim) && !sNow.emptyDimensions.includes(activeDim)) {
            sNow.setCoveredDimensions([activeDim])
          }
          pendingCompleteRef.current = true
        }
        // If still not all covered: background detectCoverageWithAI will fill gaps;
        // the useEffect below triggers completion once all dims are detected.
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

    // Do NOT eagerly mark internship/research as empty here — wait for the AI to
    // output [EMPTY:dim] explicitly. If we mark empty immediately when the user says
    // "没有", we hit a contradiction when the AI follows up and the user reveals they
    // DO have relevant experiences (e.g. TA, volunteer work,横向课题). The AI's
    // [EMPTY:dim] tag is the authoritative signal, parsed in callAI → parseAIMessage.

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
      // For dims like research where the user has no experience, the AI asks and user
      // replies with a short negative ("没有"/"这个也没有"). Mark those as emptyDimensions.
      {
        const s = useAppStore.getState()
        const NEGATIVE = /^(没有|没|无|也没有|都没有|没做过|没有过|不|没有呢|没有啊|嗯[，,].*没有|这个.*没有|这个也没有|没有[。.！!]?|暂时没有|目前没有)[。.！!]?$/
        const EXP_DIMS = ['internship', 'research']  // only exp dims can be "empty"
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

      // Refresh summaries for all currently covered dims (all in parallel)
      await generateAllSummaries(useAppStore.getState().coveredDimensions)
    } finally {
      setIsRefreshingDimensions(false)
    }
  }




  const EXP_DIMS = ['project', 'internship', 'research']

  // 生成维度AI总结（结构化短关键句，供侧边栏显示）
  async function generateDimensionSummary(dimension: string) {
    if (generatingSummaries[dimension]) return

    setGeneratingSummaries(prev => ({ ...prev, [dimension]: true }))
    summaryGeneratedAtRef.current[dimension] = useAppStore.getState().messages.length

    try {
      const { cvText: cv, cvAnalysis: cvA } = useAppStore.getState()
      const res = await fetch('/api/summarize-dimension', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dimension,
          messages: useAppStore.getState().messages,
          cvText: cv || '',
          cvAnalysis: cvA || '',
        }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      if (data.summary) {
        setDimensionSummary(dimension, data.summary)
        // Invalidate step1Summaries so highlights page regenerates with the same experience list.
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
  
  // 所有维度并行生成，各自独立扫描全量对话。
  // 不传 relatedSummaries，避免一个维度错误认领经历后其他维度永久丢失。
  async function generateAllSummaries(dims: string[]) {
    await Promise.all(dims.map(dim => generateDimensionSummary(dim)))
  }

  // 当维度被标记为完成时，自动生成AI总结
  useEffect(() => {
    const pending = coveredDimensions.filter(dim => !dimensionSummaries[dim] && !generatingSummaries[dim])
    if (pending.length > 0) generateAllSummaries(pending)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, dimensionSummaries, generatingSummaries])

  // ── Auto-recover plan/motivation when personal is done ──────────────────────
  // Runs reactively whenever coveredDimensions changes. Handles the common failure
  // mode where AI transitions plan→personal without outputting [COVERED:plan].
  useEffect(() => {
    if (!coveredDimensions.includes('personal')) return
    const toRecover = ['motivation', 'plan'].filter(
      d => !coveredDimensions.includes(d) && !emptyDimensions.includes(d)
    )
    if (toRecover.length === 0) return
    const msgs = messagesRef.current
    const src = (m: Message) => (m as Message & { rawContent?: string }).rawContent ?? m.content
    const PLAN_KW = /毕业后|未来.*规划|职业.*规划|长远.*规划|长远.*目标|职业.*目标|职业.*方向|未来.*打算|长期.*目标|短期.*计划|读完.*之后|硕士.*之后|博士.*之后|毕业.*之后|毕业.*打算|以后.*[想打]|将来.*[想打]|有什么.*规划|有没有.*规划|有没有.*打算|初步.*想法|初步.*规划|起到什么.*作用|能为你带来什么|希望.*带来什么/i
    const MOTIV_KW = /为什么.*申请|为什么.*出国|申请.*动机|什么.*吸引|感兴趣.*原因|让你.*感兴趣|让你.*投入|决定.*深造|决定.*继续|是什么.*让你.*决定|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这|吸引你的是|这个方向.*吸引/i
    const KW: Record<string, RegExp> = { plan: PLAN_KW, motivation: MOTIV_KW }
    const verified = toRecover.filter(dim => {
      // Primary: [ASKING:dim] tag exists and user replied after it
      const askIdx = msgs.findIndex(m =>
        m.role === 'assistant' &&
        new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i').test(src(m))
      )
      if (askIdx >= 0) {
        return msgs.slice(askIdx + 1).some(u => u.role === 'user' && u.content.trim().length > 8)
      }
      // Fallback: keyword match in AI message followed by substantial user reply
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
  // Handles the case where AI asked a personal-traits question after plan but
  // forgot to output [ASKING:personal] or [COVERED:personal].
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

  // Auto-complete when all dimensions become covered/empty via background detection
  // (handles the case where AI prematurely emits [INTERVIEW_COMPLETE] before
  //  all dims are tagged, then background AI detection fills in the gaps)
  useEffect(() => {
    if (interviewComplete) return
    if (isThinkingRef.current) return  // Don't trigger while AI is still streaming
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
    // AI has concluded when last message is from AI and ends without a question mark
    const aiHasConcluded = lastMsg?.role === 'assistant' && !/[？?]/.test(lastContent.slice(-400))

    if (aiHasConcluded) {
      // Force-cover/empty all dims that were asked + user replied, but AI forgot the tag
      const toForceCover: string[] = []
      const toForceEmpty: string[] = []

      // Fallback: if activeDimension is still set and AI has concluded, force-cover it
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
        // If ALL user replies to this dim are very short negatives, mark empty; otherwise covered
        const allNegative = userReplies.every(m => /^(没有|没|无|也没有|都没有|没做过|没有过|不|没有呢|没有啊)$/.test(m.content.trim()))
        if (allNegative) toForceEmpty.push(d)
        else toForceCover.push(d)
      }
      if (toForceCover.length > 0) { s.setCoveredDimensions(toForceCover); toForceCover.forEach(d => coveredSet.add(d)) }
      if (toForceEmpty.length > 0) { toForceEmpty.forEach(d => { s.markDimensionEmpty(d); empty.push(d) }) }
    }

    const allDone = ALL_DIMENSIONS.every(d => coveredSet.has(d) || empty.includes(d))
    // Don't complete if the last AI message ends with a question — student hasn't answered yet.
    // This prevents triggering completion when AI asks the personal dimension question and
    // the auto-cover logic marks it covered before the student actually responds.
    const lastAiMsg = [...msgs].reverse().find(m => m.role === 'assistant')
    const lastAiEndsWithQuestion = lastAiMsg && /[？?]/.test((lastAiMsg.rawContent ?? lastAiMsg.content).replace(/\[[\w:,\s|]+\]/g, '').trimEnd().slice(-300))
    if (allDone && !lastAiEndsWithQuestion) setInterviewComplete(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, emptyDimensions, messages.length])
  
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
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (messages.length === 0) return
                const lines: string[] = []
                lines.push('# 采访对话记录')
                lines.push(`导出时间：${new Date().toLocaleString('zh-CN')}`)
                if (quickInfo) {
                  const info = [quickInfo.school, quickInfo.major, quickInfo.gpa, quickInfo.targetSchool, quickInfo.targetMajor, quickInfo.degree].filter(Boolean)
                  if (info.length > 0) lines.push(`用户信息：${info.join(' | ')}`)
                }
                lines.push('')
                messages.forEach(m => {
                  const role = m.role === 'assistant' ? 'Omi' : '用户'
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
            {/* Skip / rephrase buttons */}
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

              // Sort by interview order: entries discussed earlier appear first.
              // Primary: use insertion order of expMessageIndex keys (added sequentially as [EXP:] tags fire).
              // Fallback: message-index scan for experiences without an [EXP:] tag.
              const expKeys = Object.keys(expMessageIndex)
              const normSimple = (s: string) => s.toLowerCase().replace(/[\s\-_]/g, '')
              function expKeyRank(name: string): number {
                // Exact match
                let idx = expKeys.indexOf(name)
                if (idx >= 0) return idx
                // Normalized match
                const nn = normSimple(name)
                idx = expKeys.findIndex(k => normSimple(k) === nn)
                if (idx >= 0) return idx
                // Fuzzy: any key whose normalized form contains/is contained by name's normalized form
                idx = expKeys.findIndex(k => {
                  const nk = normSimple(k)
                  return nk.includes(nn) || nn.includes(nk)
                })
                return idx  // -1 if not found
              }
              entries.sort((a, b) => {
                const ra = expKeyRank(a.name)
                const rb = expKeyRank(b.name)
                if (ra >= 0 && rb >= 0) return ra - rb
                if (ra >= 0) return -1
                if (rb >= 0) return 1
                // Both untagged: fall back to message-index scan
                const ia = getExpStart(a.name)
                const ib = getExpStart(b.name)
                return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib)
              })

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
                  const bullets = sumText.split('\n').map((l: string) => l.replace(/^[·•]\s*/, '').trim()).filter(Boolean)
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

                  {/* Non-exp dims: motivation / plan / personal with full summary */}
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
                                {aiSummary.split('\n').map((l: string) => l.replace(/^[·•]\s*/, '').trim()).filter(Boolean).map((b: string, bi: number) => (
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
              const summaryIsEmpty = !isGenerating && aiSummary && /^(无[。.]?|没有[^\n]{0,20}|暂无[^\n]{0,20})$/.test(aiSummary.trim())
              const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty
              // A dim is "resolved" if it's covered OR confirmed empty
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
                  {/* Card header */}
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
                          ? aiSummary.split('\n').filter((l: string) => l.startsWith('# ')).length
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
                            const lines = aiSummary.split('\n').filter((l: string) => l.trim())
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
                                    // First section fallback: if not found by name, use the dimension's overall start
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

                  {/* Live preview for active dim */}
                  {isActive && aiSummary && (
                    <div className="px-3 pb-2.5 pt-0 border-t border-stone-100">
                      {(() => {
                        const firstValue = aiSummary.split('\n').map((l: string) => {
                          const s = l.indexOf('：')
                          return s >= 0 ? l.slice(s + 1).trim() : l.replace(/^[·•]\s*/, '').trim()
                        }).find((v: string) => v && v !== '未提及')
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
