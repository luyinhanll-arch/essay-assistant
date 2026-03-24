import { streamDeepSeek } from '@/lib/deepseek'
import { DRAFT_SYSTEM_PROMPT } from '@/lib/prompts'
import type { FrameworkSection, EssayType } from '@/lib/types'

export async function POST(req: Request) {
  const {
    transcript,
    framework,
    essayType,
    targetProgram,
  }: {
    transcript: string
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

  const typeNote = essayType ? `Essay type: ${essayType}\n` : ''
  const programNote = targetProgram
    ? `Target program: ${targetProgram.split('|').map((s: string) => s.trim()).join(' · ')}\n`
    : ''

  return streamDeepSeek(DRAFT_SYSTEM_PROMPT, [
    {
      role: 'user',
      content: `IMPORTANT: Write the entire essay in English only. No Chinese characters anywhere in the output.\n\n${typeNote}${programNote}\n## Essay Framework\n${frameworkText}\n\n## Interview Transcript (source material, do not copy verbatim)\n${transcript}`,
    },
  ])
}
