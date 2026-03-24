export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const text = searchParams.get('text') || ''
  if (!text) return new Response('', { status: 400 })

  const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=zh-CN&client=tw-ob`

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://translate.google.com/',
    },
  }).catch(() => null)

  if (!resp?.ok) return new Response('', { status: 502 })

  return new Response(resp.body, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
