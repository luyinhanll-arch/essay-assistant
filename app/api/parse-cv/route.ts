import mammoth from 'mammoth'
import { extractText } from 'unpdf'

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

async function ocrImage(base64: string, mimeType: string): Promise<string> {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-vl2',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mimeType};base64,${base64}` },
            },
            {
              type: 'text',
              text: '请将图片中的简历内容完整提取为纯文本，保留原有结构和层级，不要添加任何解释。',
            },
          ],
        },
      ],
      stream: false,
    }),
  })
  if (!res.ok) throw new Error(`OCR failed: HTTP ${res.status}`)
  const data = await res.json()
  return data.choices[0].message.content as string
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData()
    const file = formData.get('file') as File | null
    if (!file) return Response.json({ error: '未收到文件' }, { status: 400 })

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const mime = file.type
    const name = file.name.toLowerCase()

    let text = ''

    if (name.endsWith('.docx') || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const result = await mammoth.extractRawText({ buffer })
      text = result.value
    } else if (name.endsWith('.pdf') || mime === 'application/pdf') {
      const { text: pages } = await extractText(new Uint8Array(bytes))
      text = Array.isArray(pages) ? pages.join('\n') : String(pages)
    } else if (mime.startsWith('image/')) {
      const base64 = buffer.toString('base64')
      text = await ocrImage(base64, mime)
    } else {
      return Response.json({ error: '不支持的文件格式' }, { status: 400 })
    }

    return Response.json({ text: text.trim() })
  } catch (err) {
    console.error('[parse-cv]', err)
    return Response.json({ error: String(err) }, { status: 500 })
  }
}
