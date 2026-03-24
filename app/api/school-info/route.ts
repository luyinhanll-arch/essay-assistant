import { callDeepSeek } from '@/lib/deepseek'
import { SCHOOL_INFO_PROMPT } from '@/lib/prompts'

// Strip HTML tags and unwanted content, return readable plain text
function extractText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

// For Reddit, use the JSON API instead of scraping HTML
function toRedditJsonUrl(url: string): string | null {
  // https://www.reddit.com/r/sub/comments/id/title/ → https://www.reddit.com/r/sub/comments/id/title.json
  if (url.includes('reddit.com')) {
    const clean = url.split('?')[0].replace(/\/$/, '')
    return clean + '.json?limit=50'
  }
  return null
}

function extractRedditText(json: unknown): string {
  const parts: string[] = []
  function walk(node: unknown) {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (obj.body && typeof obj.body === 'string') parts.push(obj.body)
    if (obj.selftext && typeof obj.selftext === 'string') parts.push(obj.selftext)
    if (obj.title && typeof obj.title === 'string') parts.push(obj.title)
    for (const val of Object.values(obj)) {
      if (typeof val === 'object') walk(val)
    }
  }
  walk(json)
  return parts.join('\n\n')
}

export async function POST(req: Request) {
  const { url }: { url: string } = await req.json()

  if (!url || !url.startsWith('http')) {
    return Response.json({ error: '请输入有效的链接（以 http 开头）' }, { status: 400 })
  }

  let pageText = ''

  try {
    const redditUrl = toRedditJsonUrl(url)

    if (redditUrl) {
      // Reddit: fetch JSON API
      const res = await fetch(redditUrl, {
        headers: { 'User-Agent': 'EssayMind/1.0 (educational app)' },
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      pageText = extractRedditText(json)
    } else {
      // General webpage
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        },
        signal: AbortSignal.timeout(12000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const html = await res.text()
      pageText = extractText(html)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `无法访问该链接：${msg}` }, { status: 400 })
  }

  if (!pageText || pageText.length < 100) {
    return Response.json({ error: '页面内容为空或无法解析，请尝试其他链接' }, { status: 400 })
  }

  // Truncate to avoid token overflow (keep ~6000 chars of content)
  const truncated = pageText.slice(0, 6000)

  let requirements: string
  try {
    requirements = await callDeepSeek(
      SCHOOL_INFO_PROMPT,
      `以下是页面内容，请提取其中与文书写作相关的要求和申请偏好信息：\n\n${truncated}`
    )
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  return Response.json({ requirements })
}
