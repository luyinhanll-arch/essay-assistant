'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'

function WordCount({ text }: { text: string }) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0
  const color = words < 500 ? 'text-yellow-600' : words > 900 ? 'text-red-500' : 'text-green-600'
  return (
    <span className={`text-sm font-mono ${color}`}>
      {words} 词 {words < 500 ? '(偏少)' : words > 900 ? '(偏多)' : '(适中)'}
    </span>
  )
}

type SentToken = { idx: number; text: string }

function parseEnSents(text: string): SentToken[][] {
  const paras = text.split(/\n\n+/).filter(p => p.trim())
  let idx = 0
  return paras.map(para => {
    const matches = para.match(/[^.!?]+[.!?]+["\u201d]?(?=\s|$)|[^.!?]+$/g) ?? [para]
    return matches.map(s => s.trim()).filter(Boolean).map(t => ({ idx: idx++, text: t }))
  })
}

function parseZhSents(text: string): SentToken[][] {
  const paras = text.split(/\n\n+/).filter(p => p.trim())
  let idx = 0
  return paras.map(para => {
    const matches = para.match(/[^。！？；…]+[。！？；…]+|[^。！？；…]+$/g) ?? [para]
    return matches.map(s => s.trim()).filter(Boolean).map(t => ({ idx: idx++, text: t }))
  })
}

// Reconstruct full text from parsed sentence paragraphs
// EN sentences are joined with a space; ZH sentences are joined without space
function rejoinText(sentParas: SentToken[][], sep = ' '): string {
  return sentParas
    .map(para => para
      .map(s => s.text)
      .filter(text => text.trim().length > 0) // Filter out empty sentences
      .join(sep)
    )
    .filter(para => para.trim().length > 0) // Filter out empty paragraphs
    .join('\n\n')
}

function EditorContent() {
  const searchParams = useSearchParams()
  const isGenerating = searchParams.get('generating') === '1'

  const router = useRouter()
  const { messages, framework, draft, essayType, targetProgram, step1Summaries, setDraft } = useAppStore()

  const [text, setText] = useState(draft)
  const [reviseInput, setReviseInput] = useState('')
  const [isRevising, setIsRevising] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const generatedRef = useRef(false)

  // Bilingual state
  const [showZh, setShowZh] = useState(false)
  const [zhText, setZhText] = useState('')
  const [isTranslating, setIsTranslating] = useState(false)
  const [zhStale, setZhStale] = useState(false)

  // Hover highlight
  const [hoveredSent, setHoveredSent] = useState<number | null>(null)
  // English edit mode toggle (bilingual view only)
  const [editingMode, setEditingMode] = useState(false)

  // Per-paragraph revision animation
  const [animatingParas, setAnimatingParas] = useState<Set<number>>(new Set())
  const [showParaView, setShowParaView] = useState(false)
  const prevTextRef = useRef<string>('')

  // Inline Chinese sentence editing
  const [editingZhIdx, setEditingZhIdx] = useState<number | null>(null)
  const [editingZhValue, setEditingZhValue] = useState('')
  // Which English sentence index is being updated after a zh edit (show pulse)
  const [updatingEnIdx, setUpdatingEnIdx] = useState<number | null>(null)
  const editZhRef = useRef<HTMLTextAreaElement>(null)
  // Prevent double-commit: textarea unmount fires blur → would call commitZhEdit twice
  const committingRef = useRef(false)

  // Focus cursor at end only when a new sentence is opened for editing
  useEffect(() => {
    if (editingZhIdx !== null && editZhRef.current) {
      editZhRef.current.focus()
      const len = editZhRef.current.value.length
      editZhRef.current.setSelectionRange(len, len)
    }
  }, [editingZhIdx])

  const enSentParas = parseEnSents(text)
  const zhSentParas = parseZhSents(zhText)

  const showSentView = showZh && !editingMode && !generating

  useEffect(() => {
    if (messages.length === 0) { router.replace('/interview'); return }
    if (framework.length === 0 && !draft) { router.replace('/framework'); return }
    if (draft) {
      setText(draft)
      return
    }
    if (isGenerating && !generatedRef.current) {
      generatedRef.current = true
      generateDraft()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function generateDraft() {
    setGenerating(true)
    try {
      const res = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summaries: step1Summaries, framework, essayType, targetProgram }),
      })
      if (!res.ok) throw new Error('生成失败')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
        setText(fullText)
      }
      setDraft(fullText)
      if (showZh) await translate(fullText)
    } catch (err) {
      console.error(err)
    } finally {
      setGenerating(false)
    }
  }

  async function translate(sourceText: string) {
    if (!sourceText.trim()) return
    setIsTranslating(true)
    setZhStale(false)
    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: sourceText }),
      })
      if (!res.ok) throw new Error('翻译失败')
      const data = await res.json()
      setZhText(data.translation ?? '')
    } catch (err) {
      console.error(err)
    } finally {
      setIsTranslating(false)
    }
  }

  function handleToggleZh() {
    const next = !showZh
    setShowZh(next)
    setEditingMode(false)
    setHoveredSent(null)
    setEditingZhIdx(null)
    if (next && !zhText && text) translate(text)
  }

  async function handleRevise() {
    const instruction = reviseInput.trim()
    if (!instruction || isRevising) return
    setIsRevising(true)
    setShowParaView(false)
    setAnimatingParas(new Set())
    prevTextRef.current = text
    try {
      const res = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: text, instruction }),
      })
      if (!res.ok) throw new Error('修改失败')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let fullText = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        fullText += decoder.decode(value, { stream: true })
        setText(fullText)
      }
      setDraft(fullText)
      setReviseInput('')
      if (showZh) setZhStale(true)
      // Diff paragraphs to find which ones changed
      const oldParas = prevTextRef.current.split(/\n\n+/).filter(p => p.trim())
      const newParas = fullText.split(/\n\n+/).filter(p => p.trim())
      const changed = new Set<number>()
      for (let i = 0; i < Math.max(oldParas.length, newParas.length); i++) {
        if ((oldParas[i] ?? '') !== (newParas[i] ?? '')) changed.add(i)
      }
      if (changed.size > 0 && changed.size < newParas.length) {
        setAnimatingParas(changed)
        setShowParaView(true)
        setTimeout(() => {
          setShowParaView(false)
          setAnimatingParas(new Set())
        }, 2500)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setIsRevising(false)
    }
  }

  function handleExportTxt() {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'SOP_Draft.txt'
    a.click()
    URL.revokeObjectURL(url)
    setExportOpen(false)
  }

  function handleExportDoc() {
    const html = `<html><head><meta charset="utf-8"></head><body><p>${text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p></body></html>`
    const blob = new Blob([html], { type: 'application/msword' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'SOP_Draft.doc'
    a.click()
    URL.revokeObjectURL(url)
    setExportOpen(false)
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setExportOpen(false)
    setTimeout(() => setCopied(false), 2000)
  }

  function startEditZh(sent: SentToken) {
    setEditingZhIdx(sent.idx)
    setEditingZhValue(sent.text)
    setHoveredSent(null)
  }

  async function commitZhEdit() {
    if (editingZhIdx === null) return
    // Read from DOM ref directly to avoid stale closure on editingZhValue
    const rawValue = editZhRef.current ? editZhRef.current.value : editingZhValue
    const newZhSent = rawValue.trim()
    
    // Snapshot current parsed state before any async ops
    const currentZhParas = zhSentParas
    const currentEnParas = enSentParas
    const savedIdx = editingZhIdx

    // Update zhText immediately - even if empty (user deleted the sentence)
    const newZhParas = currentZhParas.map(para =>
      para.map(s => s.idx === savedIdx ? { ...s, text: newZhSent } : s)
    )
    setZhText(rejoinText(newZhParas, ''))
    setEditingZhIdx(null)
    setUpdatingEnIdx(savedIdx)

    try {
      if (newZhSent) {
        // If there's content, translate Chinese → English
        const res = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: newZhSent, direction: 'zh-en' }),
        })
        if (!res.ok) throw new Error('翻译失败')
        const data = await res.json()
        const newEnSent = data.translation?.trim()
        if (newEnSent) {
          // Update English text using the snapshotted enSentParas
          const newEnParas = currentEnParas.map(para =>
            para.map(s => s.idx === savedIdx ? { ...s, text: newEnSent } : s)
          )
          const newEnFull = rejoinText(newEnParas, ' ')
          setText(newEnFull)
          setDraft(newEnFull)
        }
      } else {
        // If user deleted the Chinese sentence, also delete the corresponding English sentence
        const newEnParas = currentEnParas.map(para =>
          para.map(s => s.idx === savedIdx ? { ...s, text: '' } : s)
        )
        const newEnFull = rejoinText(newEnParas, ' ')
        setText(newEnFull)
        setDraft(newEnFull)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setUpdatingEnIdx(null)
    }
  }

  return (
    <div className="flex flex-col h-screen bg-stone-50 text-stone-900">
      {/* Header */}
      <header className="border-b border-stone-200 bg-[#FAF9F6] px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-orange-400 font-bold tracking-tight">EssayMind</Link>
          <div className="flex items-center gap-2 text-sm text-stone-400">
            <Link href="/interview" className="hover:text-stone-600 transition-colors">深度访谈</Link>
            <span>→</span>
            <Link href="/highlights" className="hover:text-stone-600 transition-colors">人设方向</Link>
            <span>→</span>
            <Link href="/framework" className="hover:text-stone-600 transition-colors">框架</Link>
            <span>→</span>
            <span className="text-stone-800 font-medium">编辑</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <WordCount text={text} />
          <button
            onClick={handleToggleZh}
            disabled={generating}
            className={`text-sm px-4 py-2 rounded-lg transition-colors border ${
              showZh
                ? 'bg-stone-900 text-white border-stone-900'
                : 'bg-stone-100 hover:bg-stone-200 text-stone-600 border-stone-200'
            } disabled:opacity-40`}
          >
            中英对照
          </button>
          {/* Export dropdown */}
          <div className="relative">
            <button
              onClick={() => setExportOpen(o => !o)}
              disabled={!text || generating}
              className="bg-stone-100 hover:bg-stone-200 disabled:opacity-40 text-stone-600 text-sm px-4 py-2 rounded-lg transition-colors border border-stone-200 flex items-center gap-1.5"
            >
              {copied ? '已复制 ✓' : '导出'}
              <span className="text-stone-400 text-xs">▾</span>
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full mt-1 bg-white border border-stone-200 rounded-xl shadow-lg z-50 py-1 w-36 overflow-hidden">
                <button onClick={handleCopy} className="w-full text-left px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">复制文本</button>
                <button onClick={handleExportTxt} className="w-full text-left px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">导出 TXT</button>
                <button onClick={handleExportDoc} className="w-full text-left px-4 py-2 text-sm text-stone-700 hover:bg-stone-50 transition-colors">导出 DOC</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        {sidebarOpen && framework.length > 0 && (
          <aside className="w-64 border-r border-stone-200 overflow-y-auto shrink-0 bg-white">
            <div className="p-4">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-stone-600">文书框架</h3>
                <button onClick={() => setSidebarOpen(false)} className="text-stone-400 hover:text-stone-600 text-xs">隐藏</button>
              </div>
              <div className="space-y-2">
                {framework.map((s, i) => (
                  <div key={i} className="bg-stone-50 border border-stone-100 rounded-lg px-3 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="w-5 h-5 rounded bg-stone-100 text-stone-700 text-xs flex items-center justify-center font-bold shrink-0">
                        {i + 1}
                      </span>
                      <span className="text-sm text-stone-900 font-medium">{s.section}</span>
                    </div>
                    <p className="text-xs text-stone-400 leading-relaxed pl-7">{s.purpose}</p>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        )}

        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="w-8 bg-white border-r border-stone-200 text-stone-400 hover:text-stone-600 text-xs flex items-center justify-center shrink-0 transition-colors"
          >
            ▶
          </button>
        )}

        {/* Editor */}
        <div className="flex-1 flex flex-col overflow-hidden bg-white">
          <div className="flex-1 flex overflow-hidden">

            {/* English side */}
            <div className="flex flex-col flex-1 overflow-hidden relative">
              {showZh && !generating && (
                <div className="absolute top-3 right-3 z-10">
                  <button
                    onClick={() => { setEditingMode(m => !m); setHoveredSent(null) }}
                    className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                      editingMode
                        ? 'bg-stone-900 text-white border-stone-900'
                        : 'bg-white text-stone-500 border-stone-200 hover:border-stone-300 hover:text-stone-700'
                    }`}
                  >
                    {editingMode ? '✓ 完成编辑' : '✏ 编辑'}
                  </button>
                </div>
              )}

              {generating ? (
                <div className="flex-1 flex flex-col items-center justify-center">
                  <div className="w-12 h-12 rounded-full border-2 border-stone-500 border-t-transparent animate-spin mb-4" />
                  <p className="text-stone-500">正在生成初稿...</p>
                  <p className="text-stone-400 text-sm mt-1">约需 15-30 秒</p>
                </div>
              ) : showSentView ? (
                <div className="flex-1 overflow-y-auto px-8 py-8 font-essay text-[15px] text-stone-800">
                  {enSentParas.length > 0 ? enSentParas.map((sents, pi) => (
                    <p key={pi} className="mb-5">
                      {sents.map(sent => (
                        <span
                          key={sent.idx}
                          className={`rounded px-0.5 py-0.5 transition-colors cursor-default ${
                            updatingEnIdx === sent.idx
                              ? 'bg-stone-200 animate-pulse'
                              : hoveredSent === sent.idx
                              ? 'bg-stone-100 text-stone-900'
                              : 'hover:bg-stone-100'
                          }`}
                          onMouseEnter={() => editingZhIdx === null && setHoveredSent(sent.idx)}
                          onMouseLeave={() => setHoveredSent(null)}
                        >
                          {sent.text}{' '}
                        </span>
                      ))}
                    </p>
                  )) : (
                    <p className="text-stone-300">你的文书将在这里生成...</p>
                  )}
                </div>
              ) : (isRevising || showParaView) ? (
                <div
                  className="flex-1 overflow-y-auto px-8 py-8 font-essay text-[15px] text-stone-800"
                  style={{ lineHeight: '1.85' }}
                  onClick={showParaView ? () => { setShowParaView(false); setAnimatingParas(new Set()) } : undefined}
                >
                  {(() => {
                    const origParas = prevTextRef.current.split(/\n\n+/).filter(p => p.trim())
                    const streamParas = text.split(/\n\n+/).filter(p => p.trim())
                    return origParas.map((orig, i) => {
                      const streamed = streamParas[i]
                      const isStreaming = isRevising && i === streamParas.length - 1
                      const hasChanged = streamed !== undefined && streamed !== orig
                      const paraText = (hasChanged || isStreaming) && streamed ? streamed : orig
                      const cls = showParaView && animatingParas.has(i)
                        ? 'para-changed'
                        : isStreaming && hasChanged
                        ? 'opacity-70'
                        : ''
                      return (
                        <p key={i} className={`mb-5 -mx-1 px-1 ${cls}`}>
                          {paraText}
                        </p>
                      )
                    })
                  })()}
                </div>
              ) : (
                <textarea
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value)
                    setDraft(e.target.value)
                    if (showZh) setZhStale(true)
                  }}
                  placeholder="你的文书将在这里生成..."
                  className="flex-1 bg-transparent text-stone-800 text-[15px] p-8 resize-none focus:outline-none placeholder-stone-300 font-essay"
                  style={{ lineHeight: '1.85' }}
                />
              )}
            </div>

            {/* Chinese translation panel */}
            {showZh && (
              <div className="w-80 border-l border-stone-200 bg-stone-50 flex flex-col overflow-hidden shrink-0">
                <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-700">中文译文</span>
                    {zhStale && (
                      <span className="text-xs bg-yellow-100 text-yellow-700 border border-yellow-300 rounded px-2 py-0.5">
                        ⚠ 译文已过期
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => translate(text)}
                    disabled={isTranslating || !text}
                    className="text-xs text-stone-500 hover:text-stone-800 disabled:opacity-40 transition-colors"
                  >
                    {isTranslating ? '翻译中...' : '重新翻译'}
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto p-5">
                  {isTranslating ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3">
                      <div className="w-8 h-8 rounded-full border-2 border-stone-400 border-t-transparent animate-spin" />
                      <p className="text-stone-500 text-sm">正在翻译...</p>
                    </div>
                  ) : zhSentParas.length > 0 ? (
                    <div>
                      <p className="text-xs text-stone-400 mb-4">点击句子可直接编辑，英文同步更新</p>
                      {zhSentParas.map((sents, pi) => (
                        <p key={pi} className="mb-5">
                          {sents.map(sent => (
                            editingZhIdx === sent.idx ? (
                              /* Inline edit textarea */
                              <textarea
                                key={sent.idx}
                                ref={editZhRef}
                                value={editingZhValue}
                                onChange={e => setEditingZhValue(e.target.value)}
                                onBlur={commitZhEdit}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitZhEdit() }
                                  if (e.key === 'Escape') setEditingZhIdx(null)
                                }}
                                rows={3}
                                className="w-full rounded-lg px-2 py-1.5 text-sm leading-relaxed bg-stone-100 border border-stone-400 text-stone-900 resize-none focus:outline-none focus:border-stone-600"
                              />
                            ) : (
                              /* Hoverable / clickable sentence span */
                              <span
                                key={sent.idx}
                                title="点击编辑"
                                className={`rounded px-0.5 py-0.5 text-sm leading-relaxed transition-colors cursor-text ${
                                  hoveredSent === sent.idx
                                    ? 'bg-stone-200 text-stone-900'
                                    : 'text-stone-700 hover:bg-stone-100'
                                }`}
                                onMouseEnter={() => editingZhIdx === null && setHoveredSent(sent.idx)}
                                onMouseLeave={() => setHoveredSent(null)}
                                onClick={() => startEditZh(sent)}
                              >
                                {sent.text}
                              </span>
                            )
                          ))}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-stone-400 text-center mt-8">点击"重新翻译"生成译文</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Revise bar */}
          <div className="border-t border-stone-200 px-6 py-4 shrink-0 bg-stone-50">
            <div className="flex gap-3 items-center">
              <div className="w-7 h-7 rounded-lg bg-stone-900 flex items-center justify-center text-sm shrink-0 text-white">✦</div>
              <input
                value={reviseInput}
                onChange={(e) => setReviseInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRevise()}
                placeholder="输入修改指令（例如：开篇改得更有冲击力；第三段加强技术细节）"
                disabled={isRevising || generating}
                className="flex-1 bg-white border border-stone-200 rounded-xl px-4 py-2.5 text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-stone-400 disabled:opacity-50 transition-colors"
              />
              <button
                onClick={handleRevise}
                disabled={isRevising || generating || !reviseInput.trim()}
                className="bg-stone-900 hover:bg-stone-800 disabled:opacity-40 text-white text-sm px-4 py-2.5 rounded-xl font-medium transition-all"
              >
                {isRevising ? '修改中...' : '修改'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function EditorPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-stone-50 flex items-center justify-center text-stone-600">加载中...</div>}>
      <EditorContent />
    </Suspense>
  )
}
