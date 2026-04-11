import { streamDeepSeek } from '@/lib/deepseek'
import { REVISE_SYSTEM_PROMPT } from '@/lib/prompts'

export async function POST(req: Request) {
  const {
    draft,
    instruction,
    paragraphMode,
    quoteMode,
  }: { draft: string; instruction: string; paragraphMode?: boolean; quoteMode?: boolean } = await req.json()

  const langRule = `CRITICAL LANGUAGE RULE: Every word must be in English. No Chinese characters (汉字) or any non-Latin script — not even for a single term like "复盘". Translate any Chinese-specific concept into English.`
  const userContent = quoteMode
    ? `${langRule} Output ONLY the replacement text — no explanation, no surrounding text.\n\n## Original text\n${draft}\n\n## Revision instruction\n${instruction}`
    : paragraphMode
    ? `${langRule} Do NOT output the full essay — just the single revised paragraph.\n\n## Paragraph to revise\n${draft}\n\n## Revision instruction\n${instruction}`
    : `${langRule}\n\n## Current essay\n${draft}\n\n## Revision instruction\n${instruction}`

  return streamDeepSeek(REVISE_SYSTEM_PROMPT, [
    { role: 'user', content: userContent },
  ])
}
