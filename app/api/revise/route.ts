import { streamDeepSeek } from '@/lib/deepseek'
import { REVISE_SYSTEM_PROMPT } from '@/lib/prompts'

export async function POST(req: Request) {
  const {
    draft,
    instruction,
    paragraphMode,
    quoteMode,
  }: { draft: string; instruction: string; paragraphMode?: boolean; quoteMode?: boolean } = await req.json()

  const userContent = quoteMode
    ? `IMPORTANT: Output only the revised sentence/phrase in English. No Chinese characters. Output ONLY the replacement text — no explanation, no surrounding text.\n\n## Original text\n${draft}\n\n## Revision instruction\n${instruction}`
    : paragraphMode
    ? `IMPORTANT: Output only the revised paragraph in English. No Chinese characters. Do NOT output the full essay — just the single revised paragraph.\n\n## Paragraph to revise\n${draft}\n\n## Revision instruction\n${instruction}`
    : `IMPORTANT: The revised essay must be entirely in English. No Chinese characters anywhere in the output.\n\n## Current essay\n${draft}\n\n## Revision instruction\n${instruction}`

  return streamDeepSeek(REVISE_SYSTEM_PROMPT, [
    { role: 'user', content: userContent },
  ])
}
