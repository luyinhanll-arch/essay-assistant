'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { INTERVIEW_DIMENSIONS } from '@/lib/types'
import type { Message } from '@/lib/types'
import { classifyInterviewQuestion, extractPreScreenAvailability, hasCompleteAcademicBackgroundEvidence, isExplicitInterviewConclusion } from '@/lib/interview-progress'
import { Mascot } from '@/components/Mascot'
import {
  recoverMissedTagsFromHistory,
  findDimStartInHistory,
  findExpStartInHistory,
  detectCoverageWithAI,
  keepSequentialDimensions,
  inferTargetFromMessages,
  parseAIMessage,
  buildInterviewProgressEvents,
} from '@/lib/interview-utils'

export default function InterviewPage() {
  const router = useRouter()
  const {
    messages,
    interviewProtocolVersion,
    interviewComplete,
    coveredDimensions,
    emptyDimensions,
    targetProgram,
    dimensionSummaries,
    dimensionMessageIndex,
    expMessageIndex,
    activeExperience,
    completedExperiences,
    activeDimension,
    addMessage,
    updateLastAssistantMessage,
    applyInterviewEvents,
    setInterviewComplete,
    setCoveredDimensions,
    removeFromCovered,
    deferDimension,
    setTargetProgram,
    setDimensionSummary,
    setActiveDimension,
    syncInterviewProgress,
    setDimensionMessageIndex,
    setExpMessageIndex,
    setActiveExperience,
    completeExperience,
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
  const generatingSummaryRef = useRef<Set<string>>(new Set())
  const summaryQueueRef = useRef<Set<string>>(new Set())
  const summaryDrainPromiseRef = useRef<Promise<void> | null>(null)
  const [expandedDimensions, setExpandedDimensions] = useState<Set<string>>(new Set())
  const [isRefreshingDimensions, setIsRefreshingDimensions] = useState(false)
  const [refreshDimensionsNotice, setRefreshDimensionsNotice] = useState('')


  const DIM_ORDER = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']

  function getCvExperienceEntries(): Array<{ name: string; type: string }> {
    const entries: Array<{ name: string; type: string }> = []
    let current: { name: string; type: string } | null = null
    for (const raw of cvAnalysis.split('\n')) {
      const line = raw.trim()
      if (/^经历名称[：:]/.test(line)) {
        if (current) entries.push(current)
        current = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '' }
      } else if (/^经历类型[：:]/.test(line) && current) {
        current.type = line.replace(/^经历类型[：:]/, '').trim()
      }
    }
    if (current) entries.push(current)
    return entries
  }

  function getCvExperienceNames(): string[] {
    return getCvExperienceEntries().map(entry => entry.name)
  }

  function normalizeExperienceName(name: string) {
    return name.toLowerCase().replace(/[\s\-_*"“”'‘’「」【】《》()（）]/g, '')
  }

  function completeCvExperience(name: string) {
    completeExperience(name)
    if (!cvText) return

    const entries = getCvExperienceEntries()
    const completedEntry = entries.find(entry =>
      normalizeExperienceName(entry.name) === normalizeExperienceName(name))
    if (!completedEntry?.type) return

    const typeToDimension: Record<string, string> = {
      科研经历: 'research',
      实习经历: 'internship',
      项目经历: 'project',
    }
    const dimension = typeToDimension[completedEntry.type]
    if (!dimension) return

    const completedNames = useAppStore.getState().completedExperiences.map(normalizeExperienceName)
    const allOfTypeDone = entries
      .filter(entry => entry.type === completedEntry.type)
      .every(entry => completedNames.includes(normalizeExperienceName(entry.name)))
    if (allOfTypeDone) setCoveredDimensions([dimension])
  }

  function detectDirectExperienceQuestion(content: string): string | null {
    if (!/[？?]/.test(content)) return null
    const questionText = content.slice(Math.max(content.lastIndexOf('。'), content.lastIndexOf('！')) + 1)
    if (/两段|上一段|前一段|另一个经历|之间.*(关系|联系)|对.*(影响|启发)|关联|延续|承接/.test(questionText)) {
      return null
    }
    // Application setup can appear in the same welcome message that previews CV
    // experiences. It is not the first formal question for any experience.
    if (/目标(?:院校|学校)|申请(?:方向|专业|项目|状态)|什么专业|硕士还是博士|硕士项目|博士项目|其他学校|是否提交|准备过程/.test(questionText)) {
      return null
    }
    if (!/为什么|怎么|如何|什么|哪些|哪一|当时|具体|负责|角色|困难|挑战|解决|结果|收获|反思|选择|决定/.test(questionText)) {
      return null
    }
    // The experience is often named earlier in the same reply and referred to as
    // “这段研究/这个项目” in the final question, so match names against the full
    // assistant reply while using the final question only for intent validation.
    const normalizedContent = normalizeExperienceName(content)
    const matches = getCvExperienceNames().map(name => {
      const normalizedName = normalizeExperienceName(name)
      const exactIndex = normalizedContent.lastIndexOf(normalizedName)
      if (exactIndex >= 0) return { name, score: 1, index: exactIndex }
      const bigrams = normalizedName.length >= 2
        ? Array.from({ length: normalizedName.length - 1 }, (_, index) => normalizedName.slice(index, index + 2))
        : []
      const matched = bigrams.filter(bigram => normalizedContent.includes(bigram)).length
      return { name, score: bigrams.length > 0 ? matched / bigrams.length : 0, index: -1 }
    })
      .filter(match => match.score >= 0.55)
      .sort((a, b) => b.score - a.score || b.index - a.index)
    return matches[0]?.name ?? null
  }

  function isPostExperienceQuestion(content: string): boolean {
    if (!/[？?]/.test(content)) return false
    if (/\[ASKING[：:]\s*(motivation|plan)\]/i.test(content)) return true
    return /为什么.*(申请|选择|深造)|申请.*(动机|原因|方向)|选择.*方向.*深造|决定.*申请|未来.*(规划|打算)|毕业后|职业.*目标|哪个具体.*(时刻|经历).*(方向|深造)/i.test(content)
  }

  function hasAnsweredInterviewQuestion(conversation: Message[], pattern: RegExp): boolean {
    const askIndex = conversation.findIndex(message => {
      if (message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      return /[？?]/.test(content) && pattern.test(content)
    })
    return askIndex >= 0 && conversation.slice(askIndex + 1)
      .some(message => message.role === 'user' && message.content.trim().length > 8)
  }

  function hasNegativeAnswerToInterviewQuestion(conversation: Message[], pattern: RegExp): boolean {
    const askIndex = conversation.findIndex(message => {
      if (message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      return /[？?]/.test(content) && pattern.test(content)
    })
    if (askIndex < 0) return false
    const reply = conversation.slice(askIndex + 1).find(message => message.role === 'user')
    return !!reply && /^(?:没有|没|无|没有特别|没什么|都没有|想不到|暂时没有|好像没有)[了呢啊。！!\s]*$/.test(reply.content.trim())
  }

  function hasCompleteMotivation(conversation: Message[]): boolean {
    const majorQuestion = /为什么.{0,24}(?:选择|申请|深耕|继续).{0,24}(?:专业|方向)|(?:专业|方向).{0,24}(?:吸引你的是什么|为什么想申请|申请原因)|是什么让你.{0,16}(?:决定|想).{0,16}(?:继续读|申请|深耕|沿着.*方向)/
    const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const targetTokens = Array.from(new Set([
      quickInfo?.targetSchool?.trim() || '',
      (quickInfo?.targetSchool || '').replace(/(?:目标)?(?:院校|学校|大学|项目)/g, '').trim(),
    ].flatMap(value => value.split(/[、，,\/|]/)).filter(value => value.length >= 2)))
    const targetAlternation = targetTokens.map(escapePattern).join('|')
    const schoolSubject = targetAlternation
      ? `(?:学校|院校|项目|地区|国家|${targetAlternation})`
      : '(?:学校|院校|项目|地区|国家)'
    const schoolQuestion = new RegExp(
      `为什么.{0,24}(?:选择|申请|想去).{0,24}${schoolSubject}|${schoolSubject}.{0,60}(?:吸引你.{0,12}是什么|为什么想|为什么选|原因|看中|契合|研究力量|培养资源)`,
      'i'
    )
    const hasAnsweredObjective = (objective: string, fallback: RegExp) => {
      const askIndex = conversation.findIndex(message =>
        message.role === 'assistant' &&
        (message.questionObjective === objective ||
          (/[？?]/.test(message.rawContent ?? message.content) &&
            fallback.test(message.rawContent ?? message.content))))
      return askIndex >= 0 && conversation.slice(askIndex + 1)
        .some(message => message.role === 'user' && message.content.trim().length > 8)
    }
    return hasAnsweredObjective('motivation_major', majorQuestion) ||
      hasAnsweredObjective('motivation_school', schoolQuestion)
  }

  function hasCompleteAcademicBackground(conversation: Message[]): boolean {
    return hasCompleteAcademicBackgroundEvidence(conversation)
  }

  // A clear verbal wrap-up is stronger evidence than the keyword-based depth
  // heuristic alone. We still require a substantive question about the exact
  // next item before advancing, so merely mentioning another experience cannot
  // reorder or skip the fixed queue.
  function hasExplicitExperienceWrapUp(content: string): boolean {
    return /(?:已经|基本)(?:把|对)?(?:这段|这份|这个|该)?(?:经历|项目|研究|实习)?.{0,12}(?:了解|聊)(?:得)?(?:比较|相当|很)?(?:完整|深入|清楚|透)|(?:这段|这个)(?:经历|项目|研究|实习)?.{0,12}(?:聊到这里|告一段落|已经聊完)|(?:好[，,。\s]*)?(?:我们)?(?:往下走|进入下一(?:个|段)(?:项目|经历|研究|实习)|接下来(?:看|聊)(?:你(?:的)?)?(?:下一(?:个|段)|另一个)(?:项目|经历|研究|实习))/i.test(content)
  }

  function recoverPrescreenEmptyDimensions(conversation: Message[]) {
    const availability = extractPreScreenAvailability(conversation)
    if (availability.research === 'unknown' && availability.internship === 'unknown') return
    const state = useAppStore.getState()
    const nextEmpty = new Set(state.emptyDimensions)
    for (const dimension of ['research', 'internship'] as const) {
      if (availability[dimension] === 'no') nextEmpty.add(dimension)
      if (availability[dimension] === 'yes') nextEmpty.delete(dimension)
    }
    // One atomic update prevents the sidebar from rendering an empty dimension as active.
    state.syncInterviewProgress({
      activeDimension: state.activeDimension,
      coveredDimensions: state.coveredDimensions,
      emptyDimensions: Array.from(nextEmpty),
    })
  }

  function getNextExperience(current: string): string | null {
    const names = getCvExperienceNames()
    const currentIndex = names.findIndex(name => normalizeExperienceName(name) === normalizeExperienceName(current))
    const completed = useAppStore.getState().completedExperiences.map(normalizeExperienceName)
    const remaining = currentIndex >= 0 ? names.slice(currentIndex + 1) : names
    return remaining.find(name => !completed.includes(normalizeExperienceName(name))) ?? null
  }

  // Local fallback for when the interview model verbally moves on but forgets
  // [EXP_DONE:]. A criterion counts only when the advisor asked about it and the
  // applicant then supplied a substantive answer.
  function hasLocalExperienceDepth(experienceName: string, conversation: Message[]): boolean {
    const start = getExpStart(experienceName)
    const scoped = start >= 0 ? conversation.slice(start) : conversation
    const criteria = {
      action: false,
      challenge: false,
      solution: false,
      outcome: false,
    }
    const questionPatterns = {
      action: /你.*(负责|做了|承担|角色|决定|选择|贡献)|具体.*(工作|行动|参与)/i,
      challenge: /困难|挑战|难点|冲突|失败|意外|瓶颈|棘手|最难/i,
      solution: /怎么|如何|解决|处理|应对|方法|调整|改进|推进/i,
      outcome: /结果|成果|影响|收获|反思|学到|发现|改变|效果/i,
    }
    const answerPatterns = {
      action: /我.*(负责|参与|完成|构建|建立|设计|实现|分析|调研|测试|尝试|选择|决定|采用|使用|提出|撰写|组织|协调)|最终.*(选择|选定|采用)|分别.*(测试|比较|分析)/i,
      challenge: /困难|挑战|难点|冲突|失败|意外|瓶颈|棘手|不足|有限|缺失|偏差|不平衡|不统一|不好找|难以|无法|不理想|出错/i,
      solution: /通过|采用|使用|参考|结合|调整|改进|处理|解决|筛选|比较|权衡|兼顾|重新|反复|因此.*(选择|保留|剔除)|最终.*(选择|选定)|指标|框架|方法/i,
      outcome: /结果|成果|显示|发现|提升|降低|高于|低于|改善|影响|价值|收获|反思|学到|意识到|最终|落地|建议|业务.*(解释|价值|意义)/i,
    }
    for (let i = 0; i < scoped.length - 1; i++) {
      const assistant = scoped[i]
      if (assistant.role !== 'assistant') continue
      const reply = scoped.slice(i + 1).find(message => message.role === 'user')
      if (!reply || reply.content.trim().length < 12) continue
      for (const criterion of Object.keys(criteria) as Array<keyof typeof criteria>) {
        if (questionPatterns[criterion].test(assistant.content) || answerPatterns[criterion].test(reply.content)) {
          criteria[criterion] = true
        }
      }
    }
    return Object.values(criteria).filter(Boolean).length >= 3
  }

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
    const LATE_DIMS = ['motivation', 'plan']
    if (LATE_DIMS.includes(dim) && coveredDimensions.includes(dim)) {
      const aiIdxs = messages.map((m, i) => m.role === 'assistant' ? i : -1).filter(i => i >= 0)
      if (aiIdxs.length > 0) {
        const target = dim === 'motivation' ? 0.65 : 0.85
        return aiIdxs[Math.floor(aiIdxs.length * target)] ?? aiIdxs[aiIdxs.length - 1]
      }
    }
    return -1
  }

  // Public wrapper: enforces that each dim's position is strictly after the previous dim's.
  // This prevents fallback estimates from landing before earlier dimensions.
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

  // Locate an experience at its first formal question. Marker and fuzzy-history
  // fallbacks are used only when no direct question can be identified.
  function getExpStart(expName: string): number {
    // Preferred source: the first assistant message that asks a direct,
    // substantive question about this exact canonical CV experience. This avoids
    // landing on an earlier mention, a later summary, or a delayed [EXP:] marker.
    const normalizedTarget = normalizeExperienceName(expName)
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]
      if (message.role !== 'assistant') continue
      const detected = detectDirectExperienceQuestion(message.rawContent ?? message.content)
      if (detected && normalizeExperienceName(detected) === normalizedTarget) return index
    }
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

  // Restore the current dimension for no-CV sessions after a refresh. A dimension
  // remains "in progress" until the advisor actually starts the next one, even if
  // the model emitted [COVERED:] early while it was still asking follow-up questions.
  useEffect(() => {
    if (isThinkingRef.current) return
    if (cvText || interviewComplete || messages.length === 0) return
    // Compatibility only: never overwrite a current dimension supplied by the
    // server state machine or by an explicit calibration.
    if (useAppStore.getState().activeDimension) return

    const latestStarts = new Map<string, number>()
    Object.entries(dimensionMessageIndex).forEach(([dimension, index]) => {
      latestStarts.set(dimension, index)
    })
    messages.forEach((message, index) => {
      if (message.role !== 'assistant') return
      const content = message.rawContent ?? message.content
      for (const match of content.matchAll(/\[ASKING[：:]\s*([^\]]+)\]/gi)) {
        const dimension = match[1].trim()
        if (!DIM_ORDER.includes(dimension)) continue
        latestStarts.set(dimension, index)
        if (!(dimension in useAppStore.getState().dimensionMessageIndex)) {
          setDimensionMessageIndex(dimension, index)
        }
      }
    })

    const latestFromMarkers = [...latestStarts.entries()]
      // A dimension confirmed as empty can never be the current interview topic.
      // This also repairs persisted pre-screen sessions that accidentally stored
      // research/internship as active before parsing a mixed yes/no answer.
      .filter(([dimension]) => DIM_ORDER.includes(dimension) && !emptyDimensions.includes(dimension))
      .sort((a, b) => b[1] - a[1])[0]?.[0]
    const latest = !hasCompleteAcademicBackground(messages) && latestStarts.has('academic')
      ? 'academic'
      : latestFromMarkers
    if (latest && useAppStore.getState().activeDimension !== latest) {
      setActiveDimension(latest)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, interviewComplete, emptyDimensions])

  // Recover a natural academic → internship transition in no-CV interviews.
  // The advisor sometimes says “接下来聊聊你那段实习” but omits both hidden
  // markers, leaving the sidebar on academic even after internship Q&As.
  useEffect(() => {
    if (isThinkingRef.current) return
    if (cvText || interviewComplete || coveredDimensions.includes('internship') || emptyDimensions.includes('internship')) return
    if (useAppStore.getState().activeDimension) return
    if (!hasCompleteAcademicBackground(messages)) return
    const state = useAppStore.getState()
    const researchReady = state.coveredDimensions.includes('research') || state.emptyDimensions.includes('research')
    if (!researchReady) return

    const academicStart = state.dimensionMessageIndex.academic ?? messages.findIndex(message =>
      message.role === 'assistant' && /(?:核心|专业)课|学术背景|你们专业.*课程/.test(message.rawContent ?? message.content)
    )
    const internshipStart = messages.findIndex((message, index) => {
      if (index <= academicStart || message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      return /[？?]/.test(content) &&
        /(?:接下来|现在|接着).{0,20}(?:实习|你那段实习)|实习.{0,20}(?:哪家公司|什么岗位|主要做什么|主要做些)|你.{0,12}(?:哪家公司|什么岗位).{0,10}实习/.test(content)
    })
    if (internshipStart < 0) return
    const internshipAnswered = messages.slice(internshipStart + 1)
      .some(message => message.role === 'user' && message.content.trim().length >= 20)
    if (!internshipAnswered) return

    if (!state.coveredDimensions.includes('academic')) setCoveredDimensions(['academic'])
    if (state.activeDimension !== 'internship') setActiveDimension('internship')
    if (!('internship' in state.dimensionMessageIndex)) setDimensionMessageIndex('internship', internshipStart)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, interviewComplete, coveredDimensions, emptyDimensions])

  // Historical no-CV fallback for sessions where the advisor verbally moved from
  // courses to independent projects but omitted both transition markers. Keep the
  // match intentionally specific so a course assignment merely mentioned during
  // academic discussion does not start the project dimension prematurely.
  useEffect(() => {
    if (isThinkingRef.current) return
    if (cvText || interviewComplete || coveredDimensions.includes('project')) return
    if (useAppStore.getState().activeDimension) return
    if (!hasCompleteAcademicBackground(messages)) return
    const state = useAppStore.getState()
    const internshipStart = state.dimensionMessageIndex.internship ?? messages.findIndex(message =>
      message.role === 'assistant' && /(?:接下来|现在).*实习|你在哪家.*实习|实习.*(?:公司|岗位|主要做)/.test(message.rawContent ?? message.content)
    )
    const internshipHasDepth = internshipStart >= 0 && messages.slice(internshipStart + 1)
      .filter(message => message.role === 'user' && message.content.trim().length >= 20)
      .length >= 2
    const researchReady = state.coveredDimensions.includes('research') || state.emptyDimensions.includes('research')
    const internshipReady = state.coveredDimensions.includes('internship') ||
      state.emptyDimensions.includes('internship') || internshipHasDepth
    const prerequisitesReady = researchReady && internshipReady
    if (!prerequisitesReady) return

    const projectStart = messages.findIndex(message => {
      if (message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      const explicitlyLeavesCourses = /往课程外面走走|除了课程(?:内|里的|项目|大作业)|除了.{0,12}(?:课程大作业|实习).{0,20}(?:竞赛|社团|项目)|课余时间里.*做过/.test(content)
      const startsIndependentExperience = /我们一个个来聊.*(?:法律援助|模拟法庭|竞赛|个人项目|社会实践|公益活动|学生组织)|先从(?:法律援助|模拟法庭|竞赛|个人项目)/.test(content)
      return /[？?]/.test(content) && (explicitlyLeavesCourses || startsIndependentExperience)
    })
    if (projectStart < 0) return

    if (!state.coveredDimensions.includes('academic')) setCoveredDimensions(['academic'])
    if (internshipHasDepth && !state.coveredDimensions.includes('internship') && !state.emptyDimensions.includes('internship')) {
      setCoveredDimensions(['internship'])
    }
    if (state.activeDimension !== 'project') setActiveDimension('project')
    if (!('project' in state.dimensionMessageIndex)) setDimensionMessageIndex('project', projectStart)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, interviewComplete, coveredDimensions, emptyDimensions])

  // Recover post-project transitions in persisted no-CV conversations when the
  // advisor used a clear natural-language question but omitted hidden markers.
  // A later planning question proves that the preceding motivation response was
  // accepted, so both transitions can be restored without guessing from mentions.
  useEffect(() => {
    if (isThinkingRef.current) return
    if (cvText || interviewComplete || messages.length === 0) return
    if (useAppStore.getState().activeDimension) return
    if (!hasCompleteAcademicBackground(messages)) return
    const state = useAppStore.getState()
    const experiencePrerequisitesReady = ['academic', 'research', 'internship'].every(dimension =>
      state.coveredDimensions.includes(dimension) || state.emptyDimensions.includes(dimension))
    const projectStarted = state.activeDimension === 'project' ||
      'project' in state.dimensionMessageIndex || state.coveredDimensions.includes('project')
    if (!experiencePrerequisitesReady || !projectStarted) return

    const motivationStart = messages.findIndex(message => {
      if (message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      return /[？?]/.test(content) &&
        /为什么.*(?:申请|选择)|怎么产生.*申请.*想法|申请.*(?:原因|动机)|什么.*(?:吸引|促使).*你|更个人的.*原因|是什么让你.*(?:确定|决定).*(?:申请|继续|方向)|对.*专业.*理解.*变化.*申请/.test(content)
    })
    if (motivationStart < 0) return

    const motivationAnswered = hasCompleteMotivation(messages)
    const planStart = messages.findIndex((message, index) => {
      if (index <= motivationStart || message.role !== 'assistant') return false
      const content = message.rawContent ?? message.content
      return /[？?]/.test(content) &&
        /未来.*(?:规划|打算|方向)|毕业后|读完.*之后|一年后的你|走出校门时|希望.*(?:留学|读书|项目|经历).*(?:带来|改变)|职业.*(?:目标|方向)/.test(content)
    })
    const planAnswered = planStart >= 0 && messages.slice(planStart + 1)
      .some(message => message.role === 'user' && message.content.trim().length > 8)
    if (!state.coveredDimensions.includes('project')) setCoveredDimensions(['project'])
    if (!('motivation' in state.dimensionMessageIndex)) setDimensionMessageIndex('motivation', motivationStart)

    if (planStart >= 0 && motivationAnswered && planAnswered) {
      const completedLateDimensions = ['motivation', 'plan'].filter(dimension =>
        !state.coveredDimensions.includes(dimension))
      if (completedLateDimensions.length > 0) setCoveredDimensions(completedLateDimensions)
      if (!('plan' in state.dimensionMessageIndex)) setDimensionMessageIndex('plan', planStart)
      setActiveDimension(null)
    } else if (planStart >= 0 && motivationAnswered) {
      if (!state.coveredDimensions.includes('motivation')) setCoveredDimensions(['motivation'])
      if (!('plan' in state.dimensionMessageIndex)) setDimensionMessageIndex('plan', planStart)
      if (state.activeDimension !== 'plan') setActiveDimension('plan')
    } else if (state.activeDimension !== 'motivation') {
      setActiveDimension('motivation')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, interviewComplete, coveredDimensions, emptyDimensions])

  // Repair both new and persisted sessions when a combined pre-screen question was
  // answered with a shared negative such as “都没有”.
  useEffect(() => {
    if (cvText || messages.length === 0) return
    recoverPrescreenEmptyDimensions(messages)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText])

  // Reconcile persisted experience completion with dimension completion. This
  // repairs older sessions where an experience received a check mark but its
  // research/internship/project summary was never generated.
  useEffect(() => {
    if (!cvText) return
    const entries = getCvExperienceEntries()
    const completed = completedExperiences.map(normalizeExperienceName)
    const typeToDimension: Record<string, string> = {
      科研经历: 'research',
      实习经历: 'internship',
      项目经历: 'project',
    }
    const dimensionsToComplete = Object.entries(typeToDimension)
      .filter(([type]) => {
        const typedEntries = entries.filter(entry => entry.type === type)
        return typedEntries.length > 0 && typedEntries.every(entry =>
          completed.includes(normalizeExperienceName(entry.name)))
      })
      .map(([, dimension]) => dimension)
      .filter(dimension => !coveredDimensions.includes(dimension))
    if (dimensionsToComplete.length > 0) setCoveredDimensions(dimensionsToComplete)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cvText, cvAnalysis, completedExperiences])

  // Recover a missing [EXP:] marker only from an actual, direct question about
  // one specific CV experience. Mentions and cross-experience comparisons do not count.
  useEffect(() => {
    if (!cvText || activeExperience) return
    const completed = completedExperiences.map(normalizeExperienceName)
    const detected = [...messages].reverse()
      .filter(message => message.role === 'assistant')
      .map(message => detectDirectExperienceQuestion(message.content))
      .find(name => !!name && !completed.includes(normalizeExperienceName(name)))
    if (!detected) return
    setActiveExperience(detected)
    if (!(detected in useAppStore.getState().expMessageIndex)) {
      const messageIndex = messages.findIndex(message =>
        message.role === 'assistant' && detectDirectExperienceQuestion(message.content) === detected)
      setExpMessageIndex(detected, messageIndex >= 0 ? messageIndex : messages.length - 1)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, activeExperience, completedExperiences])

  // Recover a missed transition from persisted conversation history (for example,
  // after refreshing a session where the advisor named the next item but omitted
  // [EXP_DONE:]).
  useEffect(() => {
    if (isThinkingRef.current) return
    if (!cvText || !activeExperience || completedExperiences.includes(activeExperience)) return
    const next = getNextExperience(activeExperience)
    const currentStart = getExpStart(activeExperience)
    if (!next) {
      const transitionIndex = messages.findIndex((message, index) =>
        index > currentStart && message.role === 'assistant' &&
        isPostExperienceQuestion(message.rawContent ?? message.content))
      const transitionMessage = transitionIndex >= 0 ? messages[transitionIndex] : null
      const canCloseCurrent = hasLocalExperienceDepth(activeExperience, messages.slice(0, transitionIndex + 1)) ||
        !!transitionMessage && hasExplicitExperienceWrapUp(transitionMessage.rawContent ?? transitionMessage.content)
      if (transitionIndex < 0 || !canCloseCurrent) return
      completeCvExperience(activeExperience)
      setActiveExperience(null)
      return
    }
    const transitionIndex = messages.findIndex((message, index) => {
      if (index <= currentStart || message.role !== 'assistant') return false
      const directlyAskedExperience = detectDirectExperienceQuestion(message.content)
      return !!directlyAskedExperience &&
        normalizeExperienceName(directlyAskedExperience) === normalizeExperienceName(next)
    })
    const transitionMessage = transitionIndex >= 0 ? messages[transitionIndex] : null
    const canCloseCurrent = hasLocalExperienceDepth(activeExperience, messages.slice(0, transitionIndex + 1)) ||
      !!transitionMessage && hasExplicitExperienceWrapUp(transitionMessage.rawContent ?? transitionMessage.content)
    if (transitionIndex < 0 || !canCloseCurrent) return
    completeCvExperience(activeExperience)
    setActiveExperience(next)
    if (!(next in useAppStore.getState().expMessageIndex)) {
      setExpMessageIndex(next, transitionIndex)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, cvText, activeExperience, completedExperiences])

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
      const requestBody = JSON.stringify({
        // The server state machine needs the complete history. Truncating here
        // made long interviews forget early answers and move backward. The API
        // may independently trim only the prose context sent to the language model.
        messages: msgs.map(m => ({
          role: m.role,
          content: m.content,
          rawContent: m.rawContent,
          questionDimension: m.questionDimension,
          questionObjective: m.questionObjective,
          questionSubject: m.questionSubject,
          questionSubjectId: m.questionSubjectId,
          progressEvents: m.progressEvents,
          id: m.id,
          replyToMessageId: m.replyToMessageId,
        })),
        coveredDimensions: snap.coveredDimensions,
        deferredDimensions: snap.deferredDimensions,
        emptyDimensions:    snap.emptyDimensions,
        cvText:             snap.cvText,
        cvAnalysis:         snap.cvAnalysis,
        quickInfo:          snap.quickInfo,
        activeExperience:   snap.activeExperience,
        completedExperiences: snap.completedExperiences,
        startedExperiences: Object.keys(snap.expMessageIndex),
      })
      let res: Response | null = null
      let lastFetchError: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          res = await fetch('/api/interview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
          })
          if (res.ok || ![502, 503, 504].includes(res.status)) break
        } catch (error) {
          lastFetchError = error
        }
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 600))
      }
      if (!res) throw lastFetchError instanceof Error ? lastFetchError : new Error('访谈接口暂时无法连接')
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errBody.error || `HTTP ${res.status}`)
      }

      const serverDimension = res.headers.get('X-Interview-Dimension')?.trim() || ''
      const serverObjective = res.headers.get('X-Interview-Objective')?.trim() || ''
      const serverSubject = decodeURIComponent(res.headers.get('X-Interview-Subject')?.trim() || '')
      const serverSubjectId = decodeURIComponent(res.headers.get('X-Interview-Subject-Id')?.trim() || '')
      const serverNeedsMoreExperiences = res.headers.get('X-Interview-Needs-More-Experiences') === 'true'
      const isPreludeQuestion = ['alternative_target', 'experience_availability'].includes(serverObjective)
      const serverCovered = (res.headers.get('X-Interview-Covered') || '')
        .split(',').map(dimension => dimension.trim()).filter(dimension => DIM_ORDER.includes(dimension))
      const serverEmpty = (res.headers.get('X-Interview-Empty') || '')
        .split(',').map(dimension => dimension.trim()).filter(dimension => DIM_ORDER.includes(dimension))
      const previousDimensionBeforeServerSync = snap.activeDimension
      if (!snap.cvText && DIM_ORDER.includes(serverDimension)) {
        // The server dimension is a planning hint, not the displayed truth. Keep
        // resolved sets in sync now; actual question metadata is applied after
        // the model finishes writing its natural-language question.
        syncInterviewProgress({
          activeDimension: snap.activeDimension,
          coveredDimensions: serverCovered,
          emptyDimensions: serverEmpty,
        })
        const state = useAppStore.getState()
        if (!(serverDimension in state.dimensionMessageIndex)) {
          setDimensionMessageIndex(serverDimension, state.messages.length - 1)
        }
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

      const { clean, covered: detectedCovered, empty, deferred, asking: detectedAsking, exp, expDone, complete, target } = parseAIMessage(fullText)
      let semanticDimension = ''
      if (interviewProtocolVersion === 1 && !isPreludeQuestion && /[？?]/.test(clean)) {
        try {
          const classifierResponse = await fetch('/api/classify-interview-question', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question: clean,
              currentDimension: useAppStore.getState().activeDimension || '',
              plannedDimension: serverDimension,
            }),
          })
          if (classifierResponse.ok) {
            const result = await classifierResponse.json() as {
              dimension?: string | null
              confidence?: number
            }
            const candidate = result.dimension || ''
            const confidence = Number(result.confidence) || 0
            const state = useAppStore.getState()
            const active = state.activeDimension || ''
            const candidateIndex = DIM_ORDER.indexOf(candidate)
            const activeIndex = DIM_ORDER.indexOf(active)
            const resolved = new Set([
              ...state.coveredDimensions,
              ...state.emptyDimensions,
              ...state.deferredDimensions,
            ])
            const doesNotMoveBackward = candidateIndex >= 0 && (activeIndex < 0 || candidateIndex >= activeIndex)
            const doesNotSkipUnresolved = candidateIndex >= 0 && (activeIndex >= 0
              ? DIM_ORDER.slice(activeIndex + 1, candidateIndex).every(dimension => resolved.has(dimension))
              : DIM_ORDER.slice(0, candidateIndex).every(dimension => resolved.has(dimension)))
            if (confidence >= 0.82 && doesNotMoveBackward && doesNotSkipUnresolved) {
              semanticDimension = candidate
            }
          }
        } catch {
          // Server plan and deterministic intent parsing remain safe fallbacks.
        }
      }
      // Protocol v2 has one controller: the server's validated turn plan.
      // Text tags and semantic classification remain v1 compatibility only.
      const classifiedQuestionDimension = interviewProtocolVersion === 1
        ? classifyInterviewQuestion(clean)
        : ''
      const inferredQuestionDimension = interviewProtocolVersion === 2
        ? (!isPreludeQuestion && DIM_ORDER.includes(serverDimension) ? serverDimension : '')
        : ((!isPreludeQuestion && DIM_ORDER.includes(serverDimension) ? serverDimension : '') ||
          semanticDimension || classifiedQuestionDimension ||
          [...detectedAsking].reverse().find(dimension => DIM_ORDER.includes(dimension)) ||
          (/[？?]/.test(clean) && snap.activeDimension && DIM_ORDER.includes(snap.activeDimension)
            ? snap.activeDimension
            : ''))
      if (inferredQuestionDimension && !detectedAsking.includes(inferredQuestionDimension)) {
        detectedAsking.push(inferredQuestionDimension)
      }
      const resolvedQuestionObjective = (
        !inferredQuestionDimension || inferredQuestionDimension === serverDimension
          ? serverObjective
          : ''
      ) || (inferredQuestionDimension ? `${inferredQuestionDimension}_follow_up` : 'conversation_opening')
      const resolvedQuestionSubject = (interviewProtocolVersion === 2 ? serverSubject : exp[exp.length - 1]) || serverSubject ||
        inferredQuestionDimension || resolvedQuestionObjective
      const authoritativeRaw = inferredQuestionDimension &&
        !new RegExp(`\\[ASKING[：:]\\s*${inferredQuestionDimension}\\]`, 'i').test(fullText)
          ? `${fullText}\n[ASKING:${inferredQuestionDimension}]`
          : fullText
      updateLastAssistantMessage(clean, authoritativeRaw, {
        questionDimension: inferredQuestionDimension || undefined,
        questionObjective: resolvedQuestionObjective,
        questionSubject: resolvedQuestionSubject,
        questionSubjectId: serverSubjectId || undefined,
      })
      if (!snap.cvText && inferredQuestionDimension) {
        setActiveDimension(inferredQuestionDimension)
      }
      setStreamingText('')
      if (target) {
        setTargetProgram(target)
      } else if (!useAppStore.getState().targetProgram) {
        inferTargetFromMessages([...msgs, { role: 'assistant', content: clean }])
      }

      // ── Record [EXP:name] markers → expMessageIndex ──────────────────────────
      const serverLocksExperience = interviewProtocolVersion === 2 &&
        !!serverSubject &&
        ['project', 'internship', 'research'].includes(inferredQuestionDimension)
      const openedExperienceNames = serverLocksExperience ? [serverSubject] : exp

      if (openedExperienceNames.length > 0) {
        const msgIdx = useAppStore.getState().messages.length - 1
        openedExperienceNames.forEach(name => {
          if (!(name in useAppStore.getState().expMessageIndex)) {
            setExpMessageIndex(name, msgIdx)
          }
        })
        setActiveExperience(openedExperienceNames[openedExperienceNames.length - 1])
      } else if (!cvText && serverSubject &&
          ['project', 'internship', 'research'].includes(inferredQuestionDimension)) {
        // The server owns the experience queue. Keep the current subject even if
        // the model forgot its [EXP:] tag, otherwise the next turn falls back to
        // project discovery and repeats the inventory question.
        setActiveExperience(serverSubject)
        const msgIdx = useAppStore.getState().messages.length - 1
        if (!(serverSubject in useAppStore.getState().expMessageIndex)) {
          setExpMessageIndex(serverSubject, msgIdx)
        }
      } else if (cvText && !useAppStore.getState().activeExperience) {
        const directlyAskedExperience = detectDirectExperienceQuestion(clean)
        if (directlyAskedExperience) {
          setActiveExperience(directlyAskedExperience)
          if (!(directlyAskedExperience in useAppStore.getState().expMessageIndex)) {
            setExpMessageIndex(directlyAskedExperience, useAppStore.getState().messages.length - 1)
          }
        }
      }
      if (expDone.length > 0) {
        expDone
          // While the server is asking about an experience, a model-generated
          // EXP_DONE marker for that same item is premature. Completion is
          // accepted only when the next server turn has actually moved on.
          .filter(name => {
            if (!serverLocksExperience) return true
            const completedName = normalizeExperienceName(name)
            const lockedName = normalizeExperienceName(serverSubject)
            return !(completedName === lockedName || completedName.includes(lockedName) || lockedName.includes(completedName))
          })
          .forEach(name => completeCvExperience(name))
      }

      // Local completion fallback. If 3/4 depth criteria have been answered and
      // the advisor starts naming the next fixed-list item, advance the queue even
      // when [EXP_DONE:] was omitted.
      if (cvText && expDone.length === 0) {
        const state = useAppStore.getState()
        const queue = getCvExperienceNames()
        const current = exp[exp.length - 1]
          || state.activeExperience
          || queue.find(name => !state.completedExperiences.some(done =>
            normalizeExperienceName(done) === normalizeExperienceName(name)))
          || ''
        const next = current ? getNextExperience(current) : null
        const directlyAskedExperience = detectDirectExperienceQuestion(clean)
        const startsNext = !!next && !!directlyAskedExperience &&
          normalizeExperienceName(directlyAskedExperience) === normalizeExperienceName(next)
        const conversationWithResponse: Message[] = [...msgs, { role: 'assistant', content: clean }]
        const currentHasDepth = current && hasLocalExperienceDepth(current, conversationWithResponse)
        const explicitlyWrappedCurrent = hasExplicitExperienceWrapUp(fullText)
        if (current && next && startsNext && (currentHasDepth || explicitlyWrappedCurrent)) {
          completeCvExperience(current)
          setActiveExperience(next)
          if (next && !(next in useAppStore.getState().expMessageIndex)) {
            setExpMessageIndex(next, useAppStore.getState().messages.length - 1)
          }
        } else if (current && !next && (currentHasDepth || explicitlyWrappedCurrent) &&
          (detectedAsking.some(dimension => ['motivation', 'plan'].includes(dimension)) || isPostExperienceQuestion(fullText))) {
          completeCvExperience(current)
          setActiveExperience(null)
        }
      }

      const pendingCvEntries = cvText
        ? getCvExperienceEntries().filter(entry => !useAppStore.getState().completedExperiences.some(done =>
          normalizeExperienceName(done) === normalizeExperienceName(entry.name)))
        : []
      const typeToDimension: Record<string, string> = {
        项目经历: 'project',
        实习经历: 'internship',
        科研经历: 'research',
      }
      const coverageHistory: Message[] = [...messagesRef.current, {
        role: 'assistant',
        content: clean,
        rawContent: authoritativeRaw,
        questionDimension: inferredQuestionDimension || undefined,
        questionObjective: resolvedQuestionObjective,
        questionSubject: resolvedQuestionSubject,
      }]
      const hasDedicatedDimensionAnswer = (dimension: string) => {
        const askIndex = coverageHistory.findIndex(message =>
          message.role === 'assistant' &&
          new RegExp(`\\[ASKING[：:]\\s*${dimension}\\]`, 'i').test(message.rawContent ?? message.content))
        return askIndex >= 0 && coverageHistory.slice(askIndex + 1)
          .some(message => message.role === 'user' && message.content.trim().length >= 20)
      }
      let covered = detectedCovered.filter(dimension => {
        if (!cvText && dimension === 'project' && serverNeedsMoreExperiences) return false
        if (['project', 'internship', 'research', 'motivation', 'plan'].includes(dimension) &&
            !hasDedicatedDimensionAnswer(dimension)) return false
        if (!cvText) {
          if (dimension === 'academic' && !hasCompleteAcademicBackground(coverageHistory)) return false
          if (dimension === 'motivation' && !hasCompleteMotivation(coverageHistory)) return false
          return true
        }
        if (['motivation', 'plan'].includes(dimension)) return pendingCvEntries.length === 0
        return !pendingCvEntries.some(entry => typeToDimension[entry.type] === dimension)
      })

      // If the advisor has formally moved forward, recover an answered earlier
      // dimension whose [COVERED:] tag was omitted (the common research case).
      const firstAskedPosition = detectedAsking.length > 0
        ? Math.min(...detectedAsking.map(dimension => DIM_ORDER.indexOf(dimension)).filter(index => index >= 0))
        : -1
      if (!cvText && firstAskedPosition > 0) {
        const state = useAppStore.getState()
        const recoverableEarlier = DIM_ORDER.slice(0, firstAskedPosition).filter(dimension =>
          !state.coveredDimensions.includes(dimension) &&
          !state.emptyDimensions.includes(dimension) &&
          hasDedicatedDimensionAnswer(dimension) &&
          (dimension !== 'academic' || hasCompleteAcademicBackground(coverageHistory)) &&
          (dimension !== 'motivation' || hasCompleteMotivation(coverageHistory)))
        covered = Array.from(new Set([...covered, ...recoverableEarlier]))
      }

      if (!cvText) {
        const state = useAppStore.getState()
        covered = keepSequentialDimensions(
          covered,
          state.coveredDimensions,
          state.emptyDimensions,
          state.deferredDimensions,
        )
      }
      const resolvedForOrder = new Set([
        ...useAppStore.getState().coveredDimensions,
        ...useAppStore.getState().emptyDimensions,
        ...useAppStore.getState().deferredDimensions,
        ...covered,
      ])
      const hasAnsweredActiveDimension = (dimension: string) => {
        if (useAppStore.getState().activeDimension !== dimension) return false
        const askStart = useAppStore.getState().dimensionMessageIndex[dimension] ?? -1
        return askStart >= 0 && coverageHistory.slice(askStart + 1)
          .some(message => message.role === 'user' && message.content.trim().length > 8)
      }
      const canStartInOrder = (dimension: string) => {
        const position = DIM_ORDER.indexOf(dimension)
        if (position < 0) return true
        // Permit the immediate transition when the model correctly starts the next
        // topic but forgot [COVERED:current]. The transition block below will then
        // recover and complete the answered current dimension.
        return DIM_ORDER.slice(0, position).every(previous =>
          resolvedForOrder.has(previous) || hasAnsweredActiveDimension(previous))
      }
      const asking = detectedAsking.filter(dimension => {
        if (cvText && ['motivation', 'plan'].includes(dimension) && pendingCvEntries.length > 0) return false
        if (!cvText && dimension === 'project' && !hasCompleteAcademicBackground(coverageHistory)) return false
        if (!cvText && dimension === 'plan' && !hasCompleteMotivation(coverageHistory)) return false
        return canStartInOrder(dimension)
      })

      // Protocol v2: this is the single authoritative write to sidebar state.
      // Legacy keyword recovery/calibration still runs for v1 sessions, but all
      // of its store writes are rejected for v2 by the store boundary.
      if (interviewProtocolVersion === 2) {
        // These values are already validated against the full conversation by
        // the server. Never merge model tags or client-side guesses back in.
        const safeEmpty = serverEmpty
        const authoritativeCovered = serverCovered
        const resolvedAfterTurn = new Set([
          ...useAppStore.getState().coveredDimensions,
          ...useAppStore.getState().emptyDimensions,
          ...authoritativeCovered,
          ...safeEmpty,
        ])
        const mayComplete = complete &&
          coverageHistory.filter(message => message.role === 'user').length >= 8 &&
          DIM_ORDER.every(dimension => resolvedAfterTurn.has(dimension))
        const progressEvents = buildInterviewProgressEvents({
          covered: authoritativeCovered,
          empty: safeEmpty,
          deferred,
          asking: serverDimension && !isPreludeQuestion ? [serverDimension] : [],
          complete: mayComplete,
        })
        updateLastAssistantMessage(clean, authoritativeRaw, {
          questionDimension: inferredQuestionDimension || undefined,
          questionObjective: resolvedQuestionObjective,
          questionSubject: resolvedQuestionSubject,
          questionSubjectId: serverSubjectId || undefined,
          progressEvents,
        })
        applyInterviewEvents(progressEvents)
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
        const explicitAvailability = extractPreScreenAvailability(allMsgsSoFar)
        const safeEmpty = empty.filter(dim => {
          if ((dim === 'research' || dim === 'internship') && explicitAvailability[dim] === 'yes') return false
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
          recoverPrescreenEmptyDimensions(msgs)
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
        generateAllSummaries(covered)
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
              await generateAllSummaries([d])
            }
          })()
        }
      }

      // ── Keyword-based activeDimension inference (fallback when AI omits [ASKING:dim]) ──
      // If the AI didn't output [ASKING:dim] but its message clearly asks about a new
      // dimension, inject the inferred dim so downstream NO_EXP_PATTERN / transition
      // logic stays accurate.
      if (asking.length === 0) {
        const DIM_ORDER = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']
        const INFER_KW: Record<string, RegExp> = {
          internship: /实习经历|有没有.*实习|聊聊.*实习|兼职/,
          research:   /科研经历|有没有.*科研|聊聊.*科研|课题组|帮.*老师.*做|实验室.*科研|科研.*实验室|发表.*论文|投稿/,
          project:    /项目经历|课程外面|课余时间.*做过|课程项目|课程设计|毕业设计|模拟法庭|法律援助|竞赛|个人项目|社会实践|公益活动|学生组织/,
          motivation: /申请动机|为什么.*申请|为什么.*出国|什么.*吸引.*你|选择.*这个.*方向|为什么.*选择|让你.*决定.*申请|什么让你.*想.*申请|吸引你的是|这个方向.*吸引|让你觉得.*吸引|对.*学校.*感兴趣|对.*专业.*感兴趣|为什么.*对.*感兴趣|让你.*对.*投入|决定.*深造|决定.*继续|是什么.*让你.*(?:决定|确定).*(?:申请|继续|方向)|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这|对.*专业.*理解.*变化.*申请/,
          plan:       /毕业后.*[想希打做]|未来.*规划|职业.*目标|职业.*方向|长期.*打算|毕业.*之后|读完.*之后|硕士.*之后|博士.*之后|有什么.*规划|有没有.*规划|有没有.*打算|初步.*规划|初步.*想法|一年后的你|走出校门时|希望.*(?:留学|读书|项目|经历).*(?:带来|改变)/,
        }
        const sInfer = useAppStore.getState()
        const curActive = sInfer.activeDimension
        const curIdx = curActive ? DIM_ORDER.indexOf(curActive) : -1
        for (const [dim, kw] of Object.entries(INFER_KW)) {
          const dimIdx = DIM_ORDER.indexOf(dim)
          // Only infer a forward transition when every preceding dimension has
          // already been resolved. Visual order and interview order stay identical.
          if (dimIdx <= curIdx) continue
          if (!canStartInOrder(dim)) continue
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
        const prevDim = serverDimension
          ? previousDimensionBeforeServerSync
          : useAppStore.getState().activeDimension
        const s = useAppStore.getState()
        const changedDimension = !!prevDim && prevDim !== asking[0]
        if (changedDimension && s.coveredDimensions.includes(prevDim)) {
          generateAllSummaries([prevDim])
        } else if (changedDimension && !s.coveredDimensions.includes(prevDim) && !s.emptyDimensions.includes(prevDim)) {
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
            if (userRepliedAfter && (prevDim !== 'motivation' || hasCompleteMotivation(allMsgs))) {
              setCoveredDimensions([prevDim])
              generateAllSummaries([prevDim])
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

        // Project summaries may be generated as soon as the third useful story
        // closes. If the applicant had already announced a fourth story, refresh
        // once we actually leave the project dimension so the sidebar contains
        // every project that was discussed, not the first three only.
        if (!cvText && asking.some(d => DIM_ORDER.indexOf(d) > DIM_ORDER.indexOf('project')) &&
            messagesRef.current.some(message => message.questionDimension === 'project' ||
              /\[ASKING[：:]\s*project\]/i.test(message.rawContent ?? message.content))) {
          generateAllSummaries(['project'])
        }
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
          generateAllSummaries([currentDim])
        }
      }

      if (complete) {
        const ALL_DIMENSIONS = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']

        // ── Force-cover dims that were asked + user replied but AI forgot [COVERED:] ──
        // When [INTERVIEW_COMPLETE] fires, trust that the interview is done.
        // Any dim with an [ASKING:dim] marker and at least one subsequent user reply
        // is considered discussed — mark it covered so the interview can fully complete.
        {
          const s = useAppStore.getState()
          const toForce = ALL_DIMENSIONS.filter(d => {
            if (s.coveredDimensions.includes(d)) return false
            if (d === 'motivation' && !hasCompleteMotivation(msgsWithResponse)) return false
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
        const lastAiContent = fullText.replace(/\[[\w:,\s|]+\]/g, '').trim()
        const endsWithQuestion = /[？?]/.test(lastAiContent.slice(-200))
        if (!endsWithQuestion) {
          // Force-cover activeDimension now (useEffect won't run after interviewComplete = true)
          const sNow = useAppStore.getState()
          const activeDim = sNow.activeDimension
          if (activeDim && !sNow.coveredDimensions.includes(activeDim) && !sNow.emptyDimensions.includes(activeDim) &&
              (activeDim !== 'motivation' || hasCompleteMotivation(msgsWithResponse))) {
            const askIdx = msgsWithResponse.findIndex(message =>
              message.role === 'assistant' &&
              new RegExp(`\\[ASKING[：:]\\s*${activeDim}\\]`, 'i').test(message.rawContent ?? message.content))
            const answered = askIdx >= 0 && msgsWithResponse.slice(askIdx + 1)
              .some(message => message.role === 'user' && message.content.trim().length > 20)
            if (answered) sNow.setCoveredDimensions([activeDim])
          }
          // Completion controls persona selection independently of sidebar coverage.
          pendingCompleteRef.current = true
        }
        // If still not all covered: background detectCoverageWithAI will fill gaps;
        // the useEffect below triggers completion once all dims are detected.
      }
    } catch (err) {
      console.warn('访谈请求失败：', err)
      updateLastAssistantMessage('连接暂时中断了，请稍后点击“换个方式问”继续。你的回答已经保留。')
    } finally {
      setIsThinking(false)
      isThinkingRef.current = false
      if (pendingCompleteRef.current) {
        pendingCompleteRef.current = false
        applyInterviewEvents([{ type: 'interview_completed' }])
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
    const latestAssistant = [...useAppStore.getState().messages].reverse()
      .find(message => message.role === 'assistant')
    const answerProgressEvents: NonNullable<Message['progressEvents']> = []
    if (interviewProtocolVersion === 2 &&
        latestAssistant?.questionObjective === 'experience_availability') {
      const availability = extractPreScreenAvailability([
        ...useAppStore.getState().messages,
        { role: 'user', content: text.trim(), replyToMessageId: latestAssistant.id },
      ])
      for (const dimension of ['research', 'internship'] as const) {
        if (availability[dimension] === 'no') {
          answerProgressEvents.push({ type: 'dimension_empty', dimension })
        } else if (availability[dimension] === 'yes') {
          answerProgressEvents.push({ type: 'dimension_available', dimension })
        }
      }
    }
    if (interviewProtocolVersion === 2 &&
        /(?:我|刚才)?(?:说错了|记错了|搞错了)|(?:刚才|上一条).{0,16}(?:不是|不算|撤回)/.test(text.trim())) {
      const latestRaw = latestAssistant?.rawContent ?? latestAssistant?.content ?? ''
      const mentionedExperiences = Array.from(latestRaw.matchAll(/\[EXP(?:_DONE)?[：:]\s*([^\]]+)\]/gi), match => match[1].trim())
      mentionedExperiences.forEach(experience => {
        answerProgressEvents.push({ type: 'experience_retracted', experience })
      })
    }
    const userMsg: Message = {
      role: 'user',
      content: text.trim(),
      replyToMessageId: latestAssistant?.id,
      ...(answerProgressEvents.length > 0 ? { progressEvents: answerProgressEvents } : {}),
    }
    addMessage(userMsg)
    if (answerProgressEvents.length > 0) applyInterviewEvents(answerProgressEvents)

    // Do NOT eagerly mark internship/research as empty here — wait for the AI to
    // output [EMPTY:dim] explicitly. If we mark empty immediately when the user says
    // "没有", we hit a contradiction when the AI follows up and the user reveals they
    // DO have relevant experiences (e.g. TA, volunteer work,横向课题). The AI's
    // [EMPTY:dim] tag is the authoritative signal, parsed in callAI → parseAIMessage.

    await callAI([...messagesRef.current, userMsg])
  }

  function recalibrateProgressFromHistory() {
    const sourceMessages = useAppStore.getState().messages
    const covered = new Set<string>()
    const empty = new Set<string>()
    const deferred = new Set<string>()
    let active: string | null = null
    let complete = false

    const canAdvanceTo = (dimension: string) => {
      const index = DIM_ORDER.indexOf(dimension)
      const activeIndex = active ? DIM_ORDER.indexOf(active) : -1
      if (activeIndex >= 0 && index < activeIndex) return false
      return index >= 0 && DIM_ORDER.slice(0, index).every(previous =>
        covered.has(previous) || empty.has(previous) || deferred.has(previous))
    }
    const applyEvent = (event: NonNullable<Message['progressEvents']>[number]) => {
      const dimension = event.dimension
      if (event.type === 'dimension_started' && dimension && canAdvanceTo(dimension)) {
        covered.delete(dimension)
        empty.delete(dimension)
        active = dimension
      } else if (event.type === 'dimension_available' && dimension) {
        covered.delete(dimension)
        empty.delete(dimension)
      } else if (event.type === 'dimension_completed' && dimension && canAdvanceTo(dimension)) {
        covered.add(dimension)
        empty.delete(dimension)
        if (active === dimension) active = null
      } else if (event.type === 'dimension_empty' && dimension) {
        empty.add(dimension)
        covered.delete(dimension)
        if (active === dimension) active = null
      } else if (event.type === 'dimension_deferred' && dimension) {
        deferred.add(dimension)
        if (active === dimension) active = null
      } else if (event.type === 'interview_completed') {
        complete = true
        active = null
      }
    }

    const recalibratedMessages = sourceMessages.map((message, index) => {
      const events: NonNullable<Message['progressEvents']> = []
      if (message.role === 'user') {
        const previousAssistant = [...sourceMessages.slice(0, index)].reverse()
          .find(candidate => candidate.role === 'assistant')
        const previousSource = previousAssistant?.rawContent ?? previousAssistant?.content ?? ''
        const isAvailabilityAnswer = previousAssistant?.questionObjective === 'experience_availability' ||
          (/[？?]/.test(previousSource) && /实习/.test(previousSource) &&
            /科研|研究|实验室|课题组/.test(previousSource))
        if (isAvailabilityAnswer) {
          const availability = extractPreScreenAvailability(sourceMessages.slice(0, index + 1))
          for (const dimension of ['research', 'internship'] as const) {
            if (availability[dimension] === 'no') events.push({ type: 'dimension_empty', dimension })
            else if (availability[dimension] === 'yes') events.push({ type: 'dimension_available', dimension })
          }
        }
        events.forEach(applyEvent)
        return events.length > 0 ? { ...message, progressEvents: events } : message
      }

      const raw = message.rawContent ?? message.content
      const parsed = parseAIMessage(raw)
      const explicitDimension = classifyInterviewQuestion(message.content) ||
        [...parsed.asking].reverse().find(dimension => DIM_ORDER.includes(dimension)) || ''
      const storedDimension = message.questionDimension && DIM_ORDER.includes(message.questionDimension)
        ? message.questionDimension
        : ''
      const storedDoesNotMoveBackward = storedDimension && (!active ||
        DIM_ORDER.indexOf(storedDimension) >= DIM_ORDER.indexOf(active))
      // Persisted server metadata is the authority for new interviews. Only
      // classify prose when older messages do not have usable metadata; otherwise
      // phrases such as “实习里的分析项目” can be recalibrated into the wrong dim.
      const explicitLaterDimension = ['motivation', 'plan'].includes(explicitDimension)
      const classified = (explicitLaterDimension ? explicitDimension : '') ||
        (storedDoesNotMoveBackward ? storedDimension : '') ||
        explicitDimension ||
        (/[？?]/.test(message.content) ? active || '' : '')

      const existingTerminalEvents = (message.progressEvents ?? []).filter(event =>
        event.type !== 'dimension_started' && event.type !== 'dimension_available')
      const parsedTerminalEvents = buildInterviewProgressEvents({
        covered: parsed.covered,
        empty: parsed.empty,
        deferred: parsed.deferred,
        asking: [],
        complete: parsed.complete,
      })
      for (const event of [...existingTerminalEvents, ...parsedTerminalEvents]) {
        if (!events.some(candidate => candidate.type === event.type && candidate.dimension === event.dimension)) {
          events.push(event)
          applyEvent(event)
        }
      }

      if (classified && active && active !== classified) {
        const currentIndex = DIM_ORDER.indexOf(active)
        const nextIndex = DIM_ORDER.indexOf(classified)
        const interveningResolved = currentIndex >= 0 && nextIndex > currentIndex &&
          DIM_ORDER.slice(currentIndex + 1, nextIndex).every(dimension =>
            covered.has(dimension) || empty.has(dimension) || deferred.has(dimension))
        if (interveningResolved) {
          const transitionEvent = { type: 'dimension_completed' as const, dimension: active }
          events.push(transitionEvent)
          applyEvent(transitionEvent)
        }
      }
      if (classified && !covered.has(classified) && !empty.has(classified)) {
        const startEvent = { type: 'dimension_started' as const, dimension: classified }
        events.push(startEvent)
        applyEvent(startEvent)
      }
      return {
        ...message,
        ...(classified ? { questionDimension: classified } : {}),
        progressEvents: events,
      }
    })

    // Calibration must reach the same terminal state as the live progress path.
    // A genuine farewell completes the interview once all six dimensions resolve.
    const lastAssistantIndex = recalibratedMessages.reduce((found, message, index) =>
      message.role === 'assistant' ? index : found, -1)
    const lastAssistant = lastAssistantIndex >= 0 ? recalibratedMessages[lastAssistantIndex] : null
    const concluded = lastAssistant?.role === 'assistant' &&
      isExplicitInterviewConclusion(lastAssistant.rawContent ?? lastAssistant.content)

    if (concluded) {
      const terminalEvents: NonNullable<Message['progressEvents']> = []
      const allResolved = DIM_ORDER.every(dimension =>
        covered.has(dimension) || empty.has(dimension) || deferred.has(dimension))
      if (!complete && allResolved) {
        const completionEvent = { type: 'interview_completed' as const }
        terminalEvents.push(completionEvent)
        applyEvent(completionEvent)
      }
      if (terminalEvents.length > 0) {
        recalibratedMessages[lastAssistantIndex] = {
          ...lastAssistant,
          progressEvents: [...(lastAssistant.progressEvents ?? []), ...terminalEvents],
        }
      }
    }

    useAppStore.setState(state => ({
      messages: recalibratedMessages,
      activeDimension: active,
      coveredDimensions: Array.from(covered),
      emptyDimensions: Array.from(empty),
      deferredDimensions: Array.from(deferred),
      interviewComplete: complete,
      progressRevision: (state.progressRevision ?? 0) + 1,
    }))
  }

  async function handleRefreshDimensions() {
    if (isRefreshingDimensions) return
    setIsRefreshingDimensions(true)
    setRefreshDimensionsNotice('')
    try {
      if (interviewProtocolVersion === 2) {
        // Rebuild exclusively from immutable server-authored progress events.
        // This is deterministic and cannot rename/reclassify experiences.
        useAppStore.getState().rebuildInterviewProgressFromMessages()
        setRefreshDimensionsNotice('校准完成')
        const calibrated = useAppStore.getState()
        const missingSummaries = calibrated.coveredDimensions.filter(dimension =>
          !calibrated.dimensionSummaries[dimension])
        if (missingSummaries.length > 0) await generateAllSummaries(missingSummaries)
        return

        /* Legacy remote audit retained temporarily for old persisted source
           compatibility; protocol v2 exits above and never executes it.
        // Do not publish the legacy local replay first. It may briefly trust stale
        // completion tags and light every card before the authoritative audit
        // returns, producing a visible completed -> active rollback.
        let auditResponse: Response | null = null
        let auditError: unknown = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            auditResponse = await fetch('/api/recalibrate-interview', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: messagesRef.current }),
            })
            break
          } catch (error) {
            auditError = error
            if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
          }
        }
        if (!auditResponse) {
          console.warn('校准进度请求失败，已保留当前进度：', auditError)
          setRefreshDimensionsNotice('校准失败：无法连接本地服务')
          return
        }
        if (auditResponse.ok) {
          const audit = await auditResponse.json() as {
            completedDimensions?: string[]
            emptyDimensions?: string[]
            activeDimension?: string | null
            interviewComplete?: boolean
            experiences?: Array<{ name: string; type: string; value: string; completed: boolean }>
          }
          const auditedCovered = (audit.completedDimensions ?? []).filter(dimension => DIM_ORDER.includes(dimension))
          const auditedEmpty = (audit.emptyDimensions ?? []).filter(dimension => DIM_ORDER.includes(dimension))
          const completedExperienceNames = (audit.experiences ?? [])
            .filter(experience => experience.completed && ['high', 'medium'].includes(experience.value))
            .map(experience => experience.name)
          useAppStore.setState(state => ({
            coveredDimensions: auditedCovered,
            emptyDimensions: auditedEmpty,
            deferredDimensions: state.deferredDimensions.filter(dimension =>
              !auditedCovered.includes(dimension) && !auditedEmpty.includes(dimension)),
            activeDimension: audit.interviewComplete ? null : (audit.activeDimension ?? null),
            activeExperience: null,
            // A no-CV interview already owns a stable experience list from the
            // live conversation events. AI audit names can vary (rename/merge/
            // split) across identical requests, so calibration must not replace it.
            completedExperiences: state.cvText
              ? Array.from(new Set(completedExperienceNames))
              : state.completedExperiences,
            interviewComplete: audit.interviewComplete === true,
            progressRevision: (state.progressRevision ?? 0) + 1,
          }))
          setRefreshDimensionsNotice('校准完成')
        } else {
          const errorBody = await auditResponse.json().catch(() => null) as { error?: string } | null
          setRefreshDimensionsNotice(`校准失败：${errorBody?.error || `HTTP ${auditResponse.status}`}`)
        }
        // Calibration repairs progress only. Keep existing summaries stable and
        // generate solely those that have never been created.
        const calibrated = useAppStore.getState()
        const isEmptySummary = (summary: string | undefined) =>
          !summary || /^(?:#\s*)?(?:[·•・]\s*)?(?:无|暂无|没有(?:对应)?(?:经历|内容)?)[。.]?$/.test(summary.trim())
        const missingSummaries = calibrated.coveredDimensions.filter(dimension =>
          isEmptySummary(calibrated.dimensionSummaries[dimension]))
        if (missingSummaries.length > 0) await generateAllSummaries(missingSummaries)
        return */
      }
      const msgs = messagesRef.current
      await detectCoverageWithAI(msgs, { reconcile: true })
      const lastAssistant = [...msgs].reverse().find(message => message.role === 'assistant')
      if (lastAssistant && isExplicitInterviewConclusion(lastAssistant.rawContent ?? lastAssistant.content)) {
        applyInterviewEvents([{ type: 'interview_completed' }])
        setInterviewComplete(true)
      }

      // Refresh summaries for all currently covered dims (all in parallel)
      await generateAllSummaries(useAppStore.getState().coveredDimensions)
      setRefreshDimensionsNotice('校准完成')
    } catch (error) {
      console.warn('校准进度失败：', error)
      setRefreshDimensionsNotice('校准失败，请确认本地服务正在运行后重试')
    } finally {
      setIsRefreshingDimensions(false)
    }
  }




  const EXP_DIMS = ['project', 'internship', 'research']

  // 生成维度AI总结（结构化短关键句，供侧边栏显示）
  async function generateDimensionSummary(dimension: string) {
    if (generatingSummaryRef.current.has(dimension)) return

    generatingSummaryRef.current.add(dimension)
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

      if (!res.ok) {
        const errorBody = await res.json().catch(() => null)
        throw new Error(errorBody?.error || `HTTP ${res.status}`)
      }

      const data = await res.json()
      if (data.summary) {
        let nextSummary = data.summary as string
        if (EXP_DIMS.includes(dimension)) {
          const summaries = useAppStore.getState().dimensionSummaries
          const normalizeTitle = (title: string) => title.toLowerCase().replace(/[\s\-—_（）()《》“”"']/g, '')
          const claimedTitles = new Set(
            EXP_DIMS.filter(dim => dim !== dimension)
              .flatMap(dim => (summaries[dim] || '').split('\n'))
              .filter(line => line.startsWith('# '))
              .map(line => normalizeTitle(line.slice(2).trim()))
          )
          const groups = nextSummary.split(/(?=^# )/m)
          nextSummary = groups.filter(group => {
            const title = group.match(/^#\s+(.+)$/m)?.[1]?.trim()
            return !title || !claimedTitles.has(normalizeTitle(title))
          }).join('').trim()
        }
        setDimensionSummary(dimension, nextSummary || '无')
        // Invalidate step1Summaries so highlights page regenerates with the same experience list.
        useAppStore.getState().setStep1Summary(dimension, '')
      }
    } catch (error) {
      console.warn(`生成维度"${dimension}"总结暂时失败:`, error)
      if (!useAppStore.getState().dimensionSummaries[dimension]) {
        const fallbackSummary = `已了解用户的${INTERVIEW_DIMENSIONS.find(d => d.key === dimension)?.label || dimension}相关信息`
        setDimensionSummary(dimension, fallbackSummary)
      }
    } finally {
      generatingSummaryRef.current.delete(dimension)
      setGeneratingSummaries(prev => ({ ...prev, [dimension]: false }))
    }
  }
  
  // 顺序生成，避免刷新时多个长对话总结请求并发触发上游限流。
  async function generateAllSummaries(dims: string[]) {
    const summaryOrder = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']
    ;[...dims].sort((a, b) => summaryOrder.indexOf(a) - summaryOrder.indexOf(b))
      .forEach(dim => summaryQueueRef.current.add(dim))
    if (!summaryDrainPromiseRef.current) {
      summaryDrainPromiseRef.current = (async () => {
        while (summaryQueueRef.current.size > 0) {
          const next = summaryQueueRef.current.values().next().value as string | undefined
          if (!next) break
          summaryQueueRef.current.delete(next)
          await generateDimensionSummary(next)
        }
      })().finally(() => {
        summaryDrainPromiseRef.current = null
      })
    }
    await summaryDrainPromiseRef.current
  }

  // 当维度被标记为完成时，自动生成AI总结
  useEffect(() => {
    const pending = coveredDimensions.filter(dim => !dimensionSummaries[dim] && !generatingSummaries[dim])
    if (pending.length > 0) generateAllSummaries(pending)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, dimensionSummaries, generatingSummaries])

  // Explicit natural-language wrap-up fallback. The interview model can produce a
  // clear farewell while forgetting [INTERVIEW_COMPLETE]. A genuine conclusion is
  // terminal on its own; coverage stays independent and may still show gaps.
  useEffect(() => {
    if (interviewComplete || isThinking) return
    const msgs = messagesRef.current
    const lastMessage = msgs[msgs.length - 1]
    if (!lastMessage || lastMessage.role !== 'assistant') return
    const content = lastMessage.rawContent ?? lastMessage.content
    if (!isExplicitInterviewConclusion(content)) return

    const allDimensions = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']
    const state = useAppStore.getState()
    const recoverable = allDimensions.filter(dimension => {
      if (state.coveredDimensions.includes(dimension) || state.emptyDimensions.includes(dimension)) return false
      const askIndex = msgs.findIndex(message =>
        message.role === 'assistant' &&
        new RegExp(`\\[ASKING[：:]\\s*${dimension}\\]`, 'i').test(message.rawContent ?? message.content))
      if (dimension === 'motivation' && !hasCompleteMotivation(msgs)) return false
      return askIndex >= 0 && msgs.slice(askIndex + 1)
        .some(message => message.role === 'user' && message.content.trim().length > 20)
    })
    // No-CV conversations occasionally contain perfectly clear dimension questions
    // but no hidden [ASKING:] tags. At a genuine farewell, recover only dimensions
    // for which a dedicated question and a substantive later answer both exist.
    const naturalQuestionPatterns: Record<string, RegExp> = {
      academic: /核心.*专业课|哪一.*课.*(?:投入|收获)|成绩.*(?:水平|排名)/,
      project: /往课程外面走走|课余时间里.*做过|模拟法庭|法律援助|竞赛|个人项目|社会实践|公益活动/,
      motivation: /为什么.*(?:申请|选择)|怎么产生.*申请.*想法|申请.*(?:原因|动机)|更个人的.*原因/,
      plan: /未来.*(?:规划|打算|方向)|毕业后|读完.*之后|一年后的你|走出校门时|希望.*(?:留学|读书|项目|经历).*(?:带来|改变)/,
    }
    const naturalRecoverable = cvText ? [] : allDimensions.filter(dimension => {
      if (state.coveredDimensions.includes(dimension) || state.emptyDimensions.includes(dimension)) return false
      const pattern = naturalQuestionPatterns[dimension]
      if (!pattern) return false
      const askIndex = msgs.findIndex(message => {
        if (message.role !== 'assistant') return false
        const question = message.rawContent ?? message.content
        return /[？?]/.test(question) && pattern.test(question)
      })
      if (dimension === 'motivation' && !hasCompleteMotivation(msgs)) return false
      return askIndex >= 0 && msgs.slice(askIndex + 1)
        .some(message => message.role === 'user' && message.content.trim().length > 20)
    })
    const dimensionsToRecover = Array.from(new Set([...recoverable, ...naturalRecoverable]))
    if (dimensionsToRecover.length > 0) setCoveredDimensions(dimensionsToRecover)
    setActiveDimension(null)
    setActiveExperience(null)
    applyInterviewEvents([{ type: 'interview_completed' }])
    setInterviewComplete(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, interviewComplete, isThinking, cvText, completedExperiences])

  // Auto-complete when all dimensions become covered/empty via background detection
  // (handles the case where AI prematurely emits [INTERVIEW_COMPLETE] before
  //  all dims are tagged, then background AI detection fills in the gaps)
  useEffect(() => {
    if (interviewComplete) return
    if (isThinking) return  // Re-run once streaming finishes.
    const ALL_DIMENSIONS = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']
    const msgs = messagesRef.current
    const userTurns = msgs.filter(m => m.role === 'user').length
    if (userTurns < 8) return

    const s = useAppStore.getState()
    const coveredSet = new Set(s.coveredDimensions)
    const empty = [...s.emptyDimensions]

    const src = (m: { rawContent?: string; content: string }) => m.rawContent ?? m.content
    const lastMsg = msgs[msgs.length - 1]
    const lastContent = lastMsg ? src(lastMsg) : ''
    // A natural farewell is terminal even if its recap contains a quoted question.
    // The explicit semantic check is shared by every interview; it is not tied to
    // a school, major, or one transcript.
    const explicitConclusion = lastMsg?.role === 'assistant' && isExplicitInterviewConclusion(lastContent)
    const aiHasConcluded = lastMsg?.role === 'assistant' &&
      (explicitConclusion || !/[？?]/.test(lastContent.slice(-400)))

    if (aiHasConcluded) {
      // Force-cover/empty all dims that were asked + user replied, but AI forgot the tag
      const toForceCover: string[] = []
      const toForceEmpty: string[] = []

      // Fallback: if activeDimension is still set and AI has concluded, force-cover it
      const activeDim = s.activeDimension
      if (activeDim && !coveredSet.has(activeDim) && !empty.includes(activeDim) &&
          (activeDim !== 'motivation' || hasCompleteMotivation(msgs))) {
        toForceCover.push(activeDim)
        coveredSet.add(activeDim)
      }

      for (const d of ALL_DIMENSIONS) {
        if (coveredSet.has(d) || empty.includes(d)) continue
        const askIdx = msgs.reduce((found, m, i) =>
          m.role === 'assistant' && new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(src(m)) ? i : found, -1)
        if (askIdx === -1) continue
        if (d === 'motivation' && !hasCompleteMotivation(msgs)) continue
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

    if (explicitConclusion) {
      setActiveDimension(null)
      setActiveExperience(null)
      applyInterviewEvents([{ type: 'interview_completed' }])
      setInterviewComplete(true)
      return
    }

    const allDone = ALL_DIMENSIONS.every(d => coveredSet.has(d) || empty.includes(d))
    // Don't complete if the last AI message ends with a question — the student
    // has not answered the final dimension yet.
    const lastAiMsg = [...msgs].reverse().find(m => m.role === 'assistant')
    const lastAiText = lastAiMsg ? (lastAiMsg.rawContent ?? lastAiMsg.content) : ''
    const lastAiEndsWithQuestion = lastAiMsg && !isExplicitInterviewConclusion(lastAiText) &&
      /[？?]/.test(lastAiText.replace(/\[[\w:,\s|]+\]/g, '').trimEnd().slice(-300))
    if (allDone && !lastAiEndsWithQuestion) {
      applyInterviewEvents([{ type: 'interview_completed' }])
      setInterviewComplete(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coveredDimensions, emptyDimensions, messages.length, isThinking])
  
  const roundCount = messages.filter((m) => m.role === 'user').length
  // While live, the sidebar consumes ordered structured state. After completion,
  // direct question-and-answer evidence is also shown so the final view reflects
  // the actual conversation even when an earlier dimension remained incomplete.
  const currentStore = useAppStore.getState()
  const independentlyAnsweredDimensions = interviewComplete
    ? DIM_ORDER.filter(dimension => {
        return messages.some((message, index) => {
          if (message.role !== 'assistant' || message.questionObjective === 'experience_availability') return false
          const semanticDimension = classifyInterviewQuestion(message.content)
          // In the completed factual view, a clearly worded question always
          // outranks stale turn metadata. Older sessions can retain academic on
          // explicit course-design/project questions, just as they can retain
          // motivation on a future-plan question.
          const detected = semanticDimension || message.questionDimension
          if (detected !== dimension) return false
          return messages.slice(index + 1).some(candidate =>
            candidate.role === 'user' && candidate.content.trim().length > 0)
        })
      })
    : []
  const noCvDisplayCovered = new Set(interviewComplete
    ? [...coveredDimensions, ...independentlyAnsweredDimensions]
    : keepSequentialDimensions(
        coveredDimensions, [], emptyDimensions, currentStore.deferredDimensions,
      ))
  const isNoCvPrerequisiteResolved = (dimension: string) => {
    const position = DIM_ORDER.indexOf(dimension)
    return position >= 0 && DIM_ORDER.slice(0, position).every(previous =>
      noCvDisplayCovered.has(previous) || emptyDimensions.includes(previous) ||
      currentStore.deferredDimensions.includes(previous))
  }
  const storedActiveIsValid = !!activeDimension && !emptyDimensions.includes(activeDimension) &&
    isNoCvPrerequisiteResolved(activeDimension)
  const noCvDisplayActive = !cvText && !interviewComplete
    ? (storedActiveIsValid ? activeDimension : null)
    : null
  const noCvResolvedCount = DIM_ORDER.filter(dimension =>
    dimension !== noCvDisplayActive &&
    noCvDisplayCovered.has(dimension) && !emptyDimensions.includes(dimension)).length
  const noCvApplicableCount = DIM_ORDER.filter(dimension =>
    !emptyDimensions.includes(dimension)).length
  const noCvActiveLabel = INTERVIEW_DIMENSIONS.find(dimension =>
    dimension.key === noCvDisplayActive)?.label
  const inferredTargetParts = targetProgram.split('|').map(part => part.trim())
  const displayedTarget = {
    school: quickInfo?.targetSchool?.trim() || inferredTargetParts[0] || '',
    major: quickInfo?.targetMajor?.trim() || inferredTargetParts[1] || '',
    degree: quickInfo?.degree?.trim() || inferredTargetParts[2] || '',
  }
  const hasDisplayedTarget = Boolean(displayedTarget.school || displayedTarget.major || displayedTarget.degree)
  // Experience counts are structural facts. Derive them from the stable live
  // EXP/EXP_DONE catalog, never from the number of AI-written summary headings.
  const stableExperienceCounts = (() => {
    const counts: Record<string, number> = { project: 0, internship: 0, research: 0 }
    const seen = new Set<string>()
    for (const experienceName of completedExperiences) {
      const normalized = normalizeExperienceName(experienceName)
      if (!normalized || seen.has(normalized)) continue
      const startIndex = getExpStart(experienceName)
      if (startIndex < 0) continue
      const opening = messages[startIndex]
      if (!opening || opening.role !== 'assistant') continue
      const source = opening.rawContent ?? opening.content
      const dimension = opening.questionDimension ||
        source.match(/\[ASKING[：:]\s*(project|internship|research)\]/i)?.[1] ||
        classifyInterviewQuestion(opening.content)
      if (!dimension || !(dimension in counts)) continue
      seen.add(normalized)
      counts[dimension] += 1
    }
    return counts
  })()
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
      <div className="flex-1 flex flex-col min-w-0 border-r border-stone-200" style={{ minWidth: 'calc(100% - 320px)' }}>
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
                  选择人设 →
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
      <aside className="w-[320px] shrink-0 bg-[#FAF9F6] flex flex-col overflow-hidden">
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
          {hasDisplayedTarget ? (
            <div className="bg-white border border-stone-200 rounded-lg px-3 py-2 mb-2">
              <p className="text-[10px] text-stone-400 font-medium mb-1 uppercase tracking-wider">目标项目</p>
              {[displayedTarget.school, displayedTarget.major, displayedTarget.degree].map((value, i) => {
                const labels = ['院校', '专业', '学位']
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
          <div className="px-4 py-3 border-b border-stone-200">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-stone-700 font-semibold">访谈进度</p>
                <p className="text-[10px] text-stone-400 mt-0.5">
                  {cvText
                    ? '按简历经历逐项深挖'
                    : interviewComplete
                      ? `已完成 ${noCvResolvedCount}/${noCvApplicableCount} 个有效维度`
                      : noCvActiveLabel
                        ? `正在了解：${noCvActiveLabel} · 已完成 ${noCvResolvedCount}/${noCvApplicableCount}`
                        : `已完成 ${noCvResolvedCount}/${noCvApplicableCount} 个有效维度`}
                </p>
              </div>
              <button
                onClick={handleRefreshDimensions}
                disabled={isRefreshingDimensions || isThinking}
                title="重新检测并校准访谈进度"
                className="text-[11px] text-stone-400 hover:text-stone-700 disabled:opacity-40 transition-colors shrink-0"
              >
                {isRefreshingDimensions ? '校准中…' : '校准进度'}
              </button>
            </div>
            {refreshDimensionsNotice && (
              <p className={`mt-1 text-[10px] ${refreshDimensionsNotice === '校准完成' ? 'text-emerald-600' : 'text-red-500'}`}>
                {refreshDimensionsNotice}
              </p>
            )}
            {!cvText && (
              <div className="mt-2.5 h-1 rounded-full bg-stone-200 overflow-hidden" aria-label={`访谈进度 ${noCvResolvedCount}/${noCvApplicableCount}`}>
                <div
                  className="h-full rounded-full bg-stone-700 transition-all duration-500"
                  style={{ width: `${noCvApplicableCount > 0 ? (noCvResolvedCount / noCvApplicableCount) * 100 : 0}%` }}
                />
              </div>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">

            {/* CV user: per-experience outline + non-exp dim summaries */}
            {cvText && (() => {
              // Parse cvAnalysis into entries
              const entries: { name: string; type: string; reason: string }[] = []
              let cur: { name: string; type: string; reason: string } | null = null
              for (const raw of cvAnalysis.split('\n')) {
                const line = raw.trim()
                if (!line) continue
                if (/^经历名称[：:]/.test(line)) {
                  if (cur) entries.push(cur)
                  cur = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '', reason: '' }
                } else if (/^经历类型[：:]/.test(line) && cur) {
                  cur.type = line.replace(/^经历类型[：:]/, '').trim()
                } else if (/^深挖原因[：:]/.test(line) && cur) {
                  cur.reason = line.replace(/^深挖原因[：:]/, '').trim()
                } else if (cur && cur.reason) {
                  cur.reason += ' ' + line
                }
              }
              if (cur) entries.push(cur)

              // Keep the CV analysis order fixed. Interview progress changes status only,
              // never the position of an entry.
              const normalizeExpName = (s: string) => s.toLowerCase().replace(/[\s\-_"“”'‘’「」【】《》()（）]/g, '')
              const isExperienceCompleted = (name: string) => {
                const normalized = normalizeExpName(name)
                return completedExperiences.some(done => normalizeExpName(done) === normalized)
              }
              const isExperienceActive = (name: string) =>
                !!activeExperience && normalizeExpName(activeExperience) === normalizeExpName(name)

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
                // Local fallback for a completed fixed-list item omitted by the
                // category-level AI summary. Use only the applicant's own answers
                // inside this experience's formal Q&A window.
                if (isExperienceCompleted(name)) {
                  const entryIndex = entries.findIndex(entry => normalizeExpName(entry.name) === normalizeExpName(name))
                  const start = getExpStart(name)
                  const nextStart = entryIndex >= 0 && entryIndex < entries.length - 1
                    ? getExpStart(entries[entryIndex + 1].name)
                    : messages.length
                  if (start >= 0) {
                    const end = nextStart > start ? nextStart : messages.length
                    const bullets = messages.slice(start, end)
                      .filter(message => message.role === 'user')
                      .flatMap(message => message.content.split(/[。！？\n]+/))
                      .map(text => text.trim())
                      .filter(text => text.length >= 8)
                      .filter(text => !/^(?:gsa|GSA).{0,20}(?:服务设计|硕士|博士|项目)|目标(?:院校|学校)|申请(?:方向|专业|项目)|硕士项目|博士项目/i.test(text))
                      .slice(0, 3)
                      .map(text => text.length > 72 ? `${text.slice(0, 72)}…` : text)
                    if (bullets.length > 0) return { bullets, dimKey: 'experience' }
                  }
                  const entry = entries[entryIndex]
                  if (entry?.reason) return { bullets: [entry.reason], dimKey: 'experience' }
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
                      <span className="text-[10px] text-stone-400">{entries.filter(e => isExperienceCompleted(e.name)).length}/{entries.length} 经历已完成</span>
                    </div>
                    <div className="divide-y divide-stone-100">
                      {entries.length > 0 ? entries.map((entry, i) => {
                        const expKey = `exp_${i}`
                        const isExpanded = expandedDimensions.has(expKey)
                        const sec = findSection(entry.name)
                        const hasSummary = !!sec && sec.bullets.length > 0
                        const isCompleted = isExperienceCompleted(entry.name)
                        const isActive = isExperienceActive(entry.name)

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
                              {isCompleted ? (
                                <span className="w-4 h-4 rounded-full bg-orange-500 text-white text-[9px] font-bold flex items-center justify-center shrink-0">✓</span>
                              ) : isActive ? (
                                <span className="w-4 h-4 rounded-full bg-orange-100 text-orange-500 text-[9px] font-bold flex items-center justify-center shrink-0 animate-pulse">{i + 1}</span>
                              ) : (
                                <span className="w-4 h-4 rounded-full bg-stone-100 text-stone-300 text-[9px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                              )}
                              <div className="flex-1 min-w-0">
                                <p className={`text-[12px] leading-snug ${isCompleted ? 'text-stone-800 font-medium' : isActive ? 'text-stone-700 font-medium' : 'text-stone-400'}`}>{entry.name}</p>
                                {entry.type && <span className="text-[9px] text-stone-400">{entry.type}</span>}
                              </div>
                              {isActive && <span className="text-[9px] text-orange-500">进行中</span>}
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

                  {/* Non-experience dimensions: motivation and plan */}
                  {NON_EXP_DIMS.map((dim) => {
                    const done = coveredDimensions.includes(dim.key)
                    const isActive = !done && activeDimension === dim.key
                    const isGenerating = generatingSummaries[dim.key]
                    const aiSummary = dimensionSummaries[dim.key]
                    const isExpanded = expandedDimensions.has(dim.key)
                    // Only internship/research can be truly empty; other dims fall back to emptyDimensions only
                    const CAN_BE_EMPTY = ['internship', 'research']
                    const summaryIsEmpty = interviewProtocolVersion === 1 && CAN_BE_EMPTY.includes(dim.key) && !isGenerating && aiSummary && /^(?:#\s*)?(无[。.]?|没有[^\n]{0,20}|暂无[^\n]{0,20})$/.test(aiSummary.trim())
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

            {/* No-CV user: six interview-dimension cards */}
            {!cvText && ['academic', 'research', 'internship', 'project', 'motivation', 'plan']
              .map(key => INTERVIEW_DIMENSIONS.find(dim => dim.key === key))
              .filter((dim): dim is typeof INTERVIEW_DIMENSIONS[number] => !!dim)
              .map((dim) => {
              const done = noCvDisplayCovered.has(dim.key)
              // “进行中”描述的是当前实际采访所处的维度。即使模型提前输出了
              // [COVERED:dim]，在切换到下一维度前也仍应优先显示“进行中”。
              const isActive = !interviewComplete && noCvDisplayActive === dim.key
              const isGenerating = generatingSummaries[dim.key]
              const aiSummary = dimensionSummaries[dim.key]
              const isExpanded = expandedDimensions.has(dim.key)
              // Treat as empty if [EMPTY:dim] was emitted, OR if the generated summary is just "无"
              const summaryIsEmpty = interviewProtocolVersion === 1 && !isGenerating && aiSummary && /^(?:#\s*)?(无[。.]?|没有[^\n]{0,20}|暂无[^\n]{0,20})$/.test(aiSummary.trim())
              const isEmpty = emptyDimensions.includes(dim.key) || !!summaryIsEmpty
              // A dim is "resolved" if it's covered OR confirmed empty
              const resolved = done || isEmpty
              const displayResolved = resolved && !isActive

              return (
                <div
                  key={dim.key}
                  className={`relative rounded-xl border transition-all overflow-hidden ${
                    displayResolved && !isEmpty
                      ? isExpanded
                        ? 'bg-white border-stone-300 shadow-sm'
                        : 'bg-white border-stone-200 cursor-pointer hover:border-stone-300 hover:bg-stone-50/40'
                      : displayResolved && isEmpty
                        ? 'bg-stone-50/70 border-stone-200'
                      : isActive
                        ? 'bg-white border-orange-200 shadow-sm'
                        : 'bg-transparent border-stone-200/70'
                  }`}
                >
                  {isActive && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-orange-400" />}
                  {/* Card header */}
                  <div
                    className={`flex items-center gap-2.5 px-3.5 py-3 ${displayResolved && !isEmpty ? 'cursor-pointer' : ''}`}
                    onClick={() => {
                      if (!displayResolved || isEmpty) return
                      setExpandedDimensions(prev => {
                        const next = new Set(prev)
                        isExpanded ? next.delete(dim.key) : next.add(dim.key)
                        return next
                      })
                    }}
                  >
                    <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 text-[9px] font-bold ${
                      displayResolved && !isEmpty ? 'bg-stone-900 text-white'
                      : displayResolved && isEmpty ? 'bg-stone-300 text-white'
                      : isActive ? 'bg-orange-100 text-orange-600 ring-2 ring-orange-50'
                      : 'bg-stone-100 text-stone-400'
                    }`}>
                      {displayResolved && !isEmpty ? '✓' : displayResolved && isEmpty ? '—' : '·'}
                    </span>
                    <span className={`flex-1 text-[13px] ${
                      displayResolved && !isEmpty ? 'text-stone-800 font-semibold'
                      : displayResolved && isEmpty ? 'text-stone-500 font-medium'
                      : isActive ? 'text-stone-800 font-semibold'
                      : 'text-stone-500'
                    }`}>
                      {dim.label}
                    </span>
                    {displayResolved && !isEmpty && (
                      isGenerating ? (
                        <span className="text-[10px] text-stone-400 animate-pulse">…</span>
                      ) : (() => {
                        const summarySectionCount = aiSummary
                          ? aiSummary.split('\n').filter((l: string) => l.startsWith('# ')).length
                          : 0
                        const isExpDim = ['project', 'internship', 'research'].includes(dim.key)
                        const sectionCount = isExpDim && stableExperienceCounts[dim.key] > 0
                          ? stableExperienceCounts[dim.key]
                          : summarySectionCount
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
                    {displayResolved && isEmpty && (
                      <span className="text-[10px] text-stone-500 bg-stone-200/80 px-2 py-0.5 rounded-full font-medium">无对应经历</span>
                    )}
                    {isActive && (
                      <span className="text-[10px] text-orange-600 bg-orange-50 border border-orange-100 px-2 py-0.5 rounded-full font-medium">进行中</span>
                    )}
                    {!displayResolved && !isActive && !isEmpty && (
                      <span className="text-[10px] text-stone-400">待访谈</span>
                    )}
                  </div>

                  {/* Expanded content */}
                  {done && !isActive && !isEmpty && isExpanded && (
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
