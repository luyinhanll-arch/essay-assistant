'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'

const ACCEPT = '.pdf,.doc,.docx,.png,.jpg,.jpeg'

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'pdf') return { label: 'PDF', bg: 'bg-red-100 text-red-600' }
  if (ext === 'docx' || ext === 'doc') return { label: 'DOC', bg: 'bg-blue-100 text-blue-600' }
  return { label: 'IMG', bg: 'bg-green-100 text-green-600' }
}

export default function OnboardingPage() {
  const router = useRouter()
  const { setCvText, setCvAnalysis, resetInterview } = useAppStore()
  const [analysis, setAnalysis] = useState('')
  const [uploadedFile, setUploadedFile] = useState<File | null>(null)
  const [fileUrl, setFileUrl] = useState<string>('')
  const [parsedText, setParsedText] = useState('')
  const [pasteText, setPasteText] = useState('')
  const [step, setStep] = useState<'idle' | 'parsing' | 'analyzing' | 'done'>('idle')
  const [parseError, setParseError] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setUploadedFile(file)
    setFileUrl(URL.createObjectURL(file))
    setStep('parsing')
    setParseError('')
    setParsedText('')
    try {
      // Step 1: parse file
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/parse-cv', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '解析失败')
      const text = data.text as string
      setParsedText(text)

      // Step 2: analyze CV
      setStep('analyzing')
      const aRes = await fetch('/api/analyze-cv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cvText: text }),
      })
      const aData = await aRes.json()
      if (aRes.ok && aData.analysis) {
        setCvAnalysis(aData.analysis)
        setAnalysis(aData.analysis)
      }

      setStep('done')
    } catch (err) {
      setParseError(String(err))
      setUploadedFile(null)
      setStep('idle')
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function removeFile() {
    setUploadedFile(null)
    setFileUrl('')
    setParsedText('')
    setAnalysis('')
    setParseError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  function openPreview() {
    const ext = uploadedFile?.name.split('.').pop()?.toLowerCase()
    if (ext === 'docx' || ext === 'doc') {
      setPreviewOpen(true)
    } else if (fileUrl) {
      window.open(fileUrl, '_blank')
    }
  }

  function handleStart() {
    const cv = uploadedFile ? parsedText : pasteText
    resetInterview()
    setCvText(cv.trim())
    router.push('/interview')
  }

  const isProcessing = step === 'parsing' || step === 'analyzing'
  const hasContent = uploadedFile ? step === 'done' : !!pasteText.trim()
  const icon = uploadedFile ? fileIcon(uploadedFile.name) : null
  const statusLabel = step === 'parsing' ? '正在提取文本...' : step === 'analyzing' ? '正在分析简历...' : step === 'done' ? '分析完成，点击预览' : ''

  return (
    <main className="min-h-screen bg-[#FAF9F6] flex flex-col items-center px-6 py-16">
      <div className="w-full max-w-xl">
        <Link href="/" className="text-sm text-stone-400 hover:text-stone-600 transition-colors mb-8 inline-block">← 返回首页</Link>

        <h1 className="text-2xl font-semibold text-stone-900 mb-2">开始之前</h1>
        <p className="text-stone-500 text-sm mb-6 leading-relaxed">
          如果你有现成的简历（CV / Resume），上传或粘贴在下方——Omi 会读取后跳过基础信息，直接追问有深度的内容，访谈会更高效。<br />
          <span className="text-stone-400">没有简历也完全没问题，直接开始即可。</span>
        </p>

        {/* Upload area */}
        {!uploadedFile ? (
          <div
            onDrop={handleDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => fileRef.current?.click()}
            className="border-2 border-dashed border-stone-200 hover:border-stone-400 rounded-xl px-6 py-5 mb-4 text-center cursor-pointer transition-colors bg-white"
          >
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            <p className="text-sm text-stone-500 mb-1">拖拽文件到此处，或点击上传</p>
            <p className="text-xs text-stone-300">支持 PDF · Word (.docx) · 图片 (PNG / JPG)</p>
          </div>
        ) : (
          <div className="flex items-center gap-3 bg-white border border-stone-200 rounded-xl px-4 py-3 mb-4">
            <button
              onClick={openPreview}
              disabled={isProcessing}
              className={`w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${icon?.bg} ${!isProcessing ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'} transition-opacity`}
            >
              {icon?.label}
            </button>
            <button
              onClick={openPreview}
              disabled={isProcessing}
              className="flex-1 min-w-0 text-left"
            >
              <p className="text-sm font-medium text-stone-800 truncate hover:underline">{uploadedFile.name}</p>
              <p className="text-xs text-stone-400 mt-0.5">{statusLabel}</p>
            </button>
            {isProcessing ? (
              <div className="w-4 h-4 rounded-full border-2 border-stone-400 border-t-transparent animate-spin shrink-0" />
            ) : (
              <button onClick={removeFile} className="text-stone-300 hover:text-stone-500 transition-colors shrink-0 text-lg leading-none">×</button>
            )}
          </div>
        )}

        {parseError && <p className="text-xs text-red-500 mb-3">{parseError}</p>}

        {/* Analysis outline */}
        {analysis && (() => {
          // Parse entries: each entry starts with "经历名称：" followed by "深挖原因："
          const entries: { name: string; reason: string }[] = []
          const lines = analysis.split('\n').map(l => l.trim()).filter(Boolean)
          let cur: { name: string; reason: string } | null = null
          for (const line of lines) {
            if (line.startsWith('经历名称：') || line.startsWith('经历名称:')) {
              if (cur) entries.push(cur)
              cur = { name: line.replace(/^经历名称[：:]/, '').trim(), reason: '' }
            } else if ((line.startsWith('深挖原因：') || line.startsWith('深挖原因:')) && cur) {
              cur.reason = line.replace(/^深挖原因[：:]/, '').trim()
            } else if (cur && cur.reason) {
              cur.reason += ' ' + line
            }
          }
          if (cur) entries.push(cur)

          return (
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-stone-700">值得重点深挖的经历</span>
                <span className="text-xs text-stone-300">· Omi 基于简历生成</span>
              </div>
              <div className="space-y-2">
                {entries.map((entry, i) => (
                  <div key={i} className="bg-white border border-stone-200 rounded-xl px-4 py-3 flex gap-3 items-start">
                    <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-500 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-stone-800 mb-1">{entry.name}</p>
                      <p className="text-xs text-stone-500 leading-relaxed">{entry.reason}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        {/* Text paste area — only show when no file uploaded */}
        {!uploadedFile && (
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder="或直接粘贴简历文本内容……"
            rows={12}
            className="w-full bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm text-stone-800 placeholder-stone-300 focus:outline-none focus:border-stone-400 resize-none leading-relaxed"
          />
        )}

        <div className="flex items-center justify-between mt-4">
          <button
            onClick={() => { resetInterview(); setCvText(''); router.push('/interview') }}
            className="text-sm text-stone-400 hover:text-stone-600 transition-colors"
          >
            跳过，直接开始
          </button>
          <button
            onClick={handleStart}
            disabled={isProcessing}
            className="bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white text-sm font-medium px-6 py-2.5 rounded-xl transition-colors"
          >
            {hasContent ? '带上简历开始访谈 →' : '开始访谈 →'}
          </button>
        </div>
      </div>

      {/* DOCX text preview modal */}
      {previewOpen && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-6" onClick={() => setPreviewOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-stone-200 shrink-0">
              <p className="text-sm font-semibold text-stone-700">{uploadedFile?.name}</p>
              <button onClick={() => setPreviewOpen(false)} className="text-stone-400 hover:text-stone-600 text-xl leading-none">×</button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <pre className="text-sm text-stone-700 whitespace-pre-wrap leading-relaxed font-sans">{parsedText}</pre>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
