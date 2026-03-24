const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

function getKey() {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY not set')
  return key
}

/** 流式调用，返回 Response（text/plain SSE → 纯文本流） */
export async function streamDeepSeek(
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[]
): Promise<Response> {
  let res: globalThis.Response
  try {
    res = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getKey()}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        stream: true,
      }),
    })
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 })
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const msg = body?.error?.message || `HTTP ${res.status}`
    return Response.json({ error: msg }, { status: res.status })
  }

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data: ')) continue
            const data = trimmed.slice(6)
            if (data === '[DONE]') continue
            try {
              const json = JSON.parse(data)
              const content = json.choices?.[0]?.delta?.content
              if (content) controller.enqueue(encoder.encode(content))
            } catch { /* skip malformed chunks */ }
          }
        }
      } catch (err) {
        console.error('[deepseek] stream error:', err)
      }
      controller.close()
    },
  })

  return new Response(readable, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

/** 非流式调用，返回纯文本 */
export async function callDeepSeek(
  systemPrompt: string,
  userPrompt: string
): Promise<string> {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getKey()}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
    }),
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error?.message || `HTTP ${res.status}`)
  }

  const data = await res.json()
  return data.choices[0].message.content as string
}
