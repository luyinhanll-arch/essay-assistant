/**
 * Shared interview logic utilities.
 * Both app/interview/page.tsx and app/test/page.tsx import from here.
 * Any change to interview detection logic should be made ONLY in this file.
 */

import { useAppStore } from '@/lib/store'
import type { Message } from '@/lib/types'

// ── Tag recovery ───────────────────────────────────────────────────────────────

/**
 * Scan the full message history for [COVERED:*] and [EMPTY:*] tags that may
 * have been missed by real-time parsing (e.g. the AI omitted the tag in that
 * turn, or the window was already scrolled past). Updates the store immediately.
 * Returns the full set of covered dims after the scan.
 */
export function recoverMissedTagsFromHistory(msgs: Message[]): string[] {
  const store = useAppStore.getState()
  const covered: string[] = []
  // Track per-dim: { emptyIdx, askingIdx } to resolve ASKING overriding EMPTY
  const emptyAt: Record<string, number> = {}   // dim → message index where [EMPTY:dim] appeared
  const askingAt: Record<string, number> = {}  // dim → message index where [ASKING:dim] appeared

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]
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
        if (!(d in emptyAt)) emptyAt[d] = i  // record first occurrence
      })
    )
    const askMatches = [...c.matchAll(/\[ASKING[：:]\s*([^\]]+)\]/gi)]
    askMatches.forEach(m => {
      const d = m[1].trim()
      if (d && !(d in askingAt)) askingAt[d] = i
    })
  }

  // A dim is truly empty only if [EMPTY:dim] was NOT followed by a later [ASKING:dim]
  // (which would mean the AI reconsidered and started asking about it anyway)
  const empty = Object.keys(emptyAt).filter(d =>
    !(d in askingAt) || askingAt[d] <= emptyAt[d]
  )

  const nowCovered = store.coveredDimensions
  const newCovered = covered.filter(d => !nowCovered.includes(d))
  if (newCovered.length > 0) store.setCoveredDimensions(newCovered)

  const nowEmpty = store.emptyDimensions
  // Also remove dims from emptyDimensions if [ASKING:dim] came after [EMPTY:dim]
  const overridden = store.emptyDimensions.filter(d =>
    d in askingAt && d in emptyAt && askingAt[d] > emptyAt[d]
  )
  if (overridden.length > 0) overridden.forEach(d => store.removeFromEmpty(d))

  const newEmpty = empty.filter(d => !nowEmpty.includes(d))
  if (newEmpty.length > 0) {
    newEmpty.forEach(d => store.markDimensionEmpty(d))
    store.setCoveredDimensions(newEmpty)
  }

  return Array.from(new Set([...nowCovered, ...newCovered, ...newEmpty]))
}

// ── Dimension start detection ──────────────────────────────────────────────────

export const KEYWORD_MAP: Record<string, RegExp> = {
  academic:   /学习经历|本科|在校|GPA|专业课/i,
  project:    /项目经历|做过.*项目|参与.*项目|课外.*活动|大作业|课程设计/i,
  internship: /实习经历|实习.*过|在.*实习|工作.*经历/i,
  research:   /科研经历|做过.*科研|有没有.*科研|有没有.*发表|有没有.*论文|加入.*实验室|加入.*课题组|正式.*科研/i,
  motivation: /申请动机|为什么.*申请|为什么.*出国|申请.*原因|什么.*吸引|感兴趣.*原因|让你.*感兴趣|对.*项目.*感兴趣|为什么.*香港|香港.*吸引|什么让你.*选择|想来.*读|选择.*申请|往.*方向发展|往.*方向.*走|聊聊.*动机|聊聊.*初衷|是什么让你.*想|为什么.*想.*读|这个.*方向.*吸引|吸引你的是|为什么选择.*这个|让你.*对.*投入|决定.*深造|决定.*继续|是什么.*让你.*决定|什么.*让你.*最终|为什么.*要去.*读|为什么.*选.*这/i,
  plan:       /未来规划|职业规划|未来.*规划|毕业后.*[想希打做]|毕业.*打算|职业.*目标|职业.*方向|未来.*打算|以后.*[想打]|将来.*[想打]|长期.*目标|短期.*计划|读完.*之后|硕士.*之后|博士.*之后|毕业.*之后|有什么.*规划|有没有.*规划|有没有.*打算|初步.*想法|初步.*规划/i,
  personal:   /个人特质|你.*是.*怎样的人|说说你这个人|关于你自己|你自己.*有这种感觉|让你.*突破.*瓶颈|成长.*多|对.*自己有了.*认识|你这个人|你.*核心.*特质|哪一次经历.*让你.*成长|让你觉得.*成长|改变了你.*看法|走出来的故事|最后一个问题|你.*身上.*特质|你.*明显.*模式|你.*明显.*特点|我发现你|聊了.*这么多.*你|你.*做事.*模式|你.*内在.*驱动|你.*一贯.*方式|你.*最深.*印象|你.*成长.*故事|让你.*印象深刻|有没有.*让你.*难忘|有没有.*成长|一件事.*改变|改变了你|有没有.*挑战|克服了什么/i,
}

/**
 * Find the index (in msgs) of the first AI message that *asks* about a dimension.
 * Primary mechanism: [ASKING:dim] marker.
 * Fallback: keyword match — but only if the message contains a `？` or `?`,
 * which filters out intro mentions like "我们待会儿会聊到实习经历".
 */
export function findDimStartInHistory(dim: string, msgs: Message[]): number {
  // Minimum prior user turns required before a dimension's first question
  // (prevents early intro/transition messages from being matched by mistake)
  const MIN_USER_TURNS: Record<string, number> = { motivation: 4, plan: 5, personal: 6 }
  const minTurns = MIN_USER_TURNS[dim] ?? 0

  // Primary: explicit [ASKING:dim] marker
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const raw = (m as Message & { rawContent?: string }).rawContent ?? m.content
    if (!new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i').test(raw)) continue
    const priorUserTurns = msgs.slice(0, i).filter(x => x.role === 'user').length
    if (priorUserTurns < minTurns) continue
    return i
  }

  // Fallback: keyword match + must contain a question mark (actual question, not a mention)
  const kw = KEYWORD_MAP[dim]
  if (!kw) return -1

  // For internship/research: only match messages AFTER formal interview starts
  // (i.e. after [ASKING:academic] appears), to avoid matching the pre-screening question.
  let formalStartIdx = 0
  if (dim === 'internship' || dim === 'research') {
    const academicIdx = msgs.findIndex(m =>
      m.role === 'assistant' &&
      /\[ASKING[：:]\s*academic\]/i.test((m as Message & { rawContent?: string }).rawContent ?? m.content)
    )
    if (academicIdx >= 0) formalStartIdx = academicIdx
  }

  // Build per-dim keyword patterns for the "other dimensions" check
  const OTHER_DIM_PATTERNS = Object.entries(KEYWORD_MAP)
    .filter(([k]) => k !== dim)
    .map(([, re]) => re)
  for (let i = formalStartIdx; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    if (!kw.test(m.content) || !/[？?]/.test(m.content)) continue
    // Skip if too many *other* dimension topics are mentioned — that's an intro/overview, not a focused question.
    // Late-stage dims (motivation/plan/personal) naturally appear in transition sentences that recap many
    // earlier topics ("聊了学术、项目、实习、科研，现在来聊动机..."), so allow a higher threshold for them.
    const otherDimCount = OTHER_DIM_PATTERNS.filter(re => re.test(m.content)).length
    const otherDimThreshold = ['motivation', 'plan', 'personal'].includes(dim) ? 6 : 3
    if (otherDimCount >= otherDimThreshold) continue
    // For late-stage dims, skip matches that appear too early in the conversation.
    const priorUserTurns = msgs.slice(0, i).filter(x => x.role === 'user').length
    if (priorUserTurns < minTurns) continue
    return i
  }
  return -1
}

// ── Experience start detection ─────────────────────────────────────────────────

/**
 * Find the index of the AI message that prompted the user's detailed description of a specific experience.
 * Strategy: first look for the earliest user message with substantial content (>80 chars) mentioning
 * the experience name, then return the AI message just before it. Falls back to the first AI message
 * that asks about the experience name (original behavior).
 */
export function findExpStartInHistory(expName: string, msgs: Message[]): number {
  const norm = (s: string) => s.toLowerCase().replace(/[\s""''「」【】《》()（）\-_·•,，.。：:]/g, '')
  const fullNorm = norm(expName)
  if (!fullNorm) return -1

  const bigrams = fullNorm.length >= 2
    ? Array.from({ length: fullNorm.length - 1 }, (_, k) => fullNorm.slice(k, k + 2))
    : []

  function score(content: string): number {
    const nc = norm(content)
    if (nc.includes(fullNorm)) return 1.0
    if (bigrams.length === 0) return 0
    return bigrams.filter(bg => nc.includes(bg)).length / bigrams.length
  }

  // Skip pre-screening phase: only search from [ASKING:academic] onwards.
  // Experiences are never formally discussed before the formal interview starts.
  const formalStart = msgs.findIndex(m =>
    m.role === 'assistant' &&
    /\[ASKING[：:]\s*academic\]/i.test((m as Message & { rawContent?: string }).rawContent ?? m.content)
  )
  const searchFrom = formalStart >= 0 ? formalStart : 0

  // Primary: find the FIRST AI message that both asks about this experience (score ≥ 0.3,
  // contains ？) AND is followed by a substantial user reply (>20 chars).
  // "First" is correct here — we want the start of detailed discussion, not the highest-scoring
  // message which could be a later follow-up that happens to mention the name more.
  for (let i = searchFrom; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    if (score(m.content) < 0.3) continue
    if (!/[？?]/.test(m.content)) continue
    const nextUser = msgs.slice(i + 1).find(x => x.role === 'user')
    if (nextUser && nextUser.content.trim().length > 20) return i
  }

  // Fallback: highest combined (AI + user) score, starting from formal interview.
  let bestIdx = -1
  let bestCombined = 0.08
  for (let i = searchFrom; i < msgs.length; i++) {
    const m = msgs[i]
    if (m.role !== 'assistant') continue
    const aiScore = score(m.content)
    let userScore = 0
    let userLen = 0
    for (let j = i + 1; j <= Math.min(i + 3, msgs.length - 1); j++) {
      if (msgs[j].role !== 'user') continue
      userScore = score(msgs[j].content)
      userLen = msgs[j].content.length
      break
    }
    if (aiScore < 0.3 && userLen < 5) continue
    const combined = aiScore * 0.35 + userScore * 0.65
    if (combined > bestCombined) { bestCombined = combined; bestIdx = i }
  }
  return bestIdx
}

// ── AI coverage detection ──────────────────────────────────────────────────────

/**
 * Detect dimension coverage via the /api/detect-dimensions endpoint.
 * Always sends the FULL message history so that:
 *  - parseTagsFromConversation can find [ASKING/COVERED/EMPTY] tags from any
 *    point in the conversation, not just a recent window.
 *  - AI analysis windows are extracted correctly even for early dimensions
 *    (research, motivation, plan) that may be 30-60+ messages in the past.
 */
export async function detectCoverageWithAI(msgs: Message[]) {
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

    // Helper: check if [ASKING:dim] appeared anywhere in history
    const hasAskingMarker = (d: string) =>
      msgs.some(m => m.role === 'assistant' &&
        new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(m.rawContent ?? m.content))

    if (data.coveredDimensions?.length > 0) {
      const nowCovered = useAppStore.getState().coveredDimensions
      // For strict dims (research/motivation/plan/personal):
      // Strict dims (research/motivation/plan/personal) require BOTH:
      // - [ASKING:dim] marker present (AI explicitly opened the topic), AND
      // - conf >= 0.6 from window analysis
      // This prevents false positives when keywords appear in early transition
      // messages before the AI actually starts asking about the dimension.
      const STRICT_DIMS = new Set(['internship', 'research', 'motivation', 'plan', 'personal'])
      const dimMap: Record<string, number> = {}
      if (Array.isArray(data.dimensions)) {
        for (const d of data.dimensions) dimMap[d.key] = d.confidence ?? 0
      }
      const newDims = (data.coveredDimensions as string[]).filter(d => {
        if (nowCovered.includes(d)) return false
        if (STRICT_DIMS.has(d)) {
          const conf = dimMap[d] ?? 0
          if (conf < 0.6 || !hasAskingMarker(d)) return false
          // Also require at least one substantial user reply AFTER [ASKING:dim]
          // to prevent marking covered just because [ASKING:dim] appeared.
          const askIdx = msgs.findIndex(m =>
            m.role === 'assistant' &&
            new RegExp(`\\[ASKING[：:]\\s*${d}\\]`, 'i').test(m.rawContent ?? m.content)
          )
          if (askIdx < 0) return false
          return msgs.slice(askIdx + 1).some(m => m.role === 'user' && m.content.trim().length > 20)
        }
        return true
      })
      if (newDims.length > 0) {
        useAppStore.getState().setCoveredDimensions(newDims)
      }
    }

    // Mark empty dims — AI analysis may detect empty even when AI forgot [EMPTY:] tag
    // Require [ASKING:dim] in history before marking empty, to prevent false positives
    // where the AI infers "no experience" from context before it has even asked.
    if (Array.isArray(data.dimensions)) {
      const store = useAppStore.getState()
      const existing = store.dimensionSummaries
      for (const dim of data.dimensions) {
        if (dim.covered && dim.empty && dim.confidence >= 0.6 && hasAskingMarker(dim.key)) {
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

// ── Target program inference ───────────────────────────────────────────────────

// 从历史对话中推断目标项目信息（兜底：AI 未能输出 [TARGET:] 标记时使用）
// 扫描顾问的回复，看是否有确认目标院校的话语；同时扫描用户消息里的学校/专业/学位关键词
export function inferTargetFromMessages(msgs: Message[]) {
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
    // Always keep all three fields in order (school|major|degree), even if empty,
    // so the sidebar display doesn't shift labels when a field is missing.
    const target = [schools, major, degree].join('|')
    useAppStore.getState().setTargetProgram(target)
  }
}

// ── AI message parser ──────────────────────────────────────────────────────────

export function parseAIMessage(raw: string): {
  clean: string
  covered: string[]
  empty: string[]
  deferred: string[]
  asking: string[]
  exp: string[]
  complete: boolean
  target: string | null
} {
  let clean = raw
  let covered: string[] = []
  let empty: string[] = []
  let deferred: string[] = []
  let asking: string[] = []
  let exp: string[] = []
  let complete = false
  let target: string | null = null

  const targetMatch = clean.match(/\[TARGET[：:]\s*([^\]]*)\]/)
  if (targetMatch) {
    const candidate = targetMatch[1].trim()
    // Require at least one '|' — guarantees school|program format; rejects single-field outputs like [TARGET:商业分析]
    if (candidate.includes('|')) {
      // Pad to exactly 3 fields (school|major|degree) so display labels never shift
      const fields = candidate.split('|')
      while (fields.length < 3) fields.push('')
      target = fields.slice(0, 3).join('|')
    }
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
  const expMatches = [...clean.matchAll(/\[EXP[：:]\s*([^\]]+)\]/g)]
  if (expMatches.length > 0) {
    exp = expMatches.map(m => m[1].trim()).filter(Boolean)
    clean = clean.replace(/\[EXP[：:][^\]]*\]/g, '').trim()
  }
  if (clean.includes('[INTERVIEW_COMPLETE]')) {
    complete = true
    clean = clean.replace('[INTERVIEW_COMPLETE]', '').trim()
  }
  return { clean, covered, empty, deferred, asking, exp, complete, target }
}
