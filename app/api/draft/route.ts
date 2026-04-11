import { streamDeepSeek, callDeepSeek } from '@/lib/deepseek'
import { DRAFT_SYSTEM_PROMPT, TRANSLATE_ZH_TO_EN_PROMPT } from '@/lib/prompts'
import type { FrameworkSection, EssayType } from '@/lib/types'

async function translateToEnglish(text: string): Promise<string> {
  if (!text.trim()) return text
  // Skip translation if already mostly English (no CJK characters)
  if (!/[\u4e00-\u9fff\u3040-\u30ff]/.test(text)) return text
  return callDeepSeek(TRANSLATE_ZH_TO_EN_PROMPT, text)
}

const DIM_LABELS: Record<string, string> = {
  academic:   'Academic Background',
  project:    'Project Experience',
  internship: 'Internship Experience',
  research:   'Research Experience',
  motivation: 'Application Motivation',
  plan:       'Future Plans',
  personal:   'Personal Qualities',
}

export async function POST(req: Request) {
  const {
    summaries,
    framework,
    essayType,
    targetProgram,
    wordLimit,
  }: {
    summaries: Record<string, string>
    framework: FrameworkSection[]
    essayType?: EssayType
    targetProgram?: string
    wordLimit?: string
  } = await req.json()

  const rawFrameworkText = framework
    .map(
      (s) =>
        `[Section: ${s.section}]\nPurpose: ${s.purpose}\nKey points: ${s.keyPoints.join('; ')}\nSuggested content: ${s.suggestedContent}`
    )
    .join('\n\n')

  const rawSummaryText = Object.entries(summaries)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `[${DIM_LABELS[k] ?? k}]\n${v.trim()}`)
    .join('\n\n')

  // Translate source material to English so the writer model never sees Chinese
  const [frameworkText, summaryText] = await Promise.all([
    translateToEnglish(rawFrameworkText),
    translateToEnglish(rawSummaryText),
  ])

  const typeNote = essayType ? `Essay type: ${essayType}\n` : ''
  const programNote = targetProgram
    ? `Target program: ${targetProgram.split('|').map((s: string) => s.trim()).join(' · ')}\n`
    : ''
  const wordLimitNote = wordLimit ? `Word limit: ${wordLimit} words — strictly stay within this limit.\n` : ''

  return streamDeepSeek(DRAFT_SYSTEM_PROMPT, [
    {
      role: 'user',
      content: `CRITICAL LANGUAGE RULE: Every single word in the essay must be in English. Do NOT include any Chinese characters (汉字), Japanese, or any non-Latin script anywhere — not even for a single word, brand name, or term like "复盘". If a concept is Chinese-specific, translate or describe it in English.\n\n${typeNote}${programNote}${wordLimitNote}\n## Essay Framework\n${frameworkText}\n\n## Applicant Background Summaries (use as source material)\n${summaryText}\n\nReminder: Output English only. Zero Chinese characters.`,
    },
  ])
}
