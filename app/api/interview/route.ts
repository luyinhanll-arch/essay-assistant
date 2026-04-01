import { streamDeepSeek } from '@/lib/deepseek'
import { buildInterviewSystemPrompt } from '@/lib/prompts'
import type { Message } from '@/lib/types'

const ALL_DIMENSIONS = ['academic', 'project', 'internship', 'research', 'motivation', 'plan', 'personal']

export async function POST(req: Request) {
  const {
    messages,
    coveredDimensions = [],
    deferredDimensions = [],
    emptyDimensions = [],
    cvText = '',
    cvAnalysis = '',
  }: { messages: Message[]; coveredDimensions?: string[]; deferredDimensions?: string[]; emptyDimensions?: string[]; cvText?: string; cvAnalysis?: string } = await req.json()

  // Exclude both covered and deferred from the normal list
  const missing = ALL_DIMENSIONS.filter(
    d => !coveredDimensions.includes(d) && !deferredDimensions.includes(d)
  )

  // Re-insert uncovered deferred dimensions just before 'personal'
  const uncoveredDeferred = deferredDimensions.filter(d => !coveredDimensions.includes(d))
  if (uncoveredDeferred.length > 0) {
    const personalIdx = missing.indexOf('personal')
    if (personalIdx >= 0) {
      missing.splice(personalIdx, 0, ...uncoveredDeferred)
    } else {
      missing.push(...uncoveredDeferred)
    }
  }

  // ── Guard: personal must not appear before motivation + plan are handled ──
  // If either motivation or plan is still in missing (i.e. not covered/deferred),
  // remove personal from missing entirely so the AI cannot skip ahead to it.
  {
    const motivationHandled = coveredDimensions.includes('motivation') || deferredDimensions.includes('motivation')
    const planHandled = coveredDimensions.includes('plan')
    if (!motivationHandled || !planHandled) {
      const personalIdx = missing.indexOf('personal')
      if (personalIdx >= 0) missing.splice(personalIdx, 1)
    }
  }

  // ── 3-experience check (frontend-driven) ─────────────────────────────────
  // Once all of project/internship/research are resolved, verify total
  // non-empty experiences ≥ 3. If not, inject a boost task before motivation.
  const expDims = ['project', 'internship', 'research']
  const allExpResolved = expDims.every(d => coveredDimensions.includes(d) || emptyDimensions.includes(d))
  const nonEmptyExpCount = expDims.filter(d => coveredDimensions.includes(d) && !emptyDimensions.includes(d)).length
  const needsExpBoost = allExpResolved && nonEmptyExpCount < 3 && !coveredDimensions.includes('motivation')

  if (needsExpBoost && !missing.includes('needs_more_experiences')) {
    const motivationIdx = missing.indexOf('motivation')
    if (motivationIdx >= 0) {
      missing.splice(motivationIdx, 0, 'needs_more_experiences')
    } else {
      missing.unshift('needs_more_experiences')
    }
  }

  // Convert structured cvAnalysis into natural prompt text
  let cvAnalysisForPrompt = ''
  if (cvAnalysis.trim()) {
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
    if (entries.length > 0) {
      cvAnalysisForPrompt = entries
        .map((e, i) => `${i + 1}. 【${e.name}】：${e.reason}`)
        .join('\n')
    } else {
      cvAnalysisForPrompt = cvAnalysis.trim()
    }
  }

  return streamDeepSeek(
    buildInterviewSystemPrompt(missing, cvText, cvAnalysisForPrompt),
    messages.map((m) => ({ role: m.role, content: m.content }))
  )
}
