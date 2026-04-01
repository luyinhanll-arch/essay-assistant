import { streamDeepSeek } from '@/lib/deepseek'
import { DRAFT_SYSTEM_PROMPT } from '@/lib/prompts'
import type { FrameworkSection, EssayType } from '@/lib/types'

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
  }: {
    summaries: Record<string, string>
    framework: FrameworkSection[]
    essayType?: EssayType
    targetProgram?: string
  } = await req.json()

  const frameworkText = framework
    .map(
      (s) =>
        `[Section: ${s.section}]\nPurpose: ${s.purpose}\nKey points: ${s.keyPoints.join('; ')}\nSuggested content: ${s.suggestedContent}`
    )
    .join('\n\n')

  const summaryText = Object.entries(summaries)
    .filter(([, v]) => v && v.trim())
    .map(([k, v]) => `[${DIM_LABELS[k] ?? k}]\n${v.trim()}`)
    .join('\n\n')

  const typeNote = essayType ? `Essay type: ${essayType}\n` : ''
  const programNote = targetProgram
    ? `Target program: ${targetProgram.split('|').map((s: string) => s.trim()).join(' · ')}\n`
    : ''

  return streamDeepSeek(DRAFT_SYSTEM_PROMPT, [
    {
      role: 'user',
      content: `IMPORTANT: Write the entire essay in English only. No Chinese characters anywhere in the output.\n\n${typeNote}${programNote}\n## Essay Framework\n${frameworkText}\n\n## Applicant Background Summaries (use as source material)\n${summaryText}`,
    },
  ])
}
