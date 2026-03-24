import { streamDeepSeek } from '@/lib/deepseek'
import { REVISE_SYSTEM_PROMPT } from '@/lib/prompts'

export async function POST(req: Request) {
  const {
    draft,
    instruction,
  }: { draft: string; instruction: string } = await req.json()

  return streamDeepSeek(REVISE_SYSTEM_PROMPT, [
    {
      role: 'user',
      content: `IMPORTANT: The revised essay must be entirely in English. No Chinese characters anywhere in the output.\n\n## Current essay\n${draft}\n\n## Revision instruction\n${instruction}`,
    },
  ])
}
