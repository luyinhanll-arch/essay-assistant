'use client'

import { useState, useEffect, useRef, Suspense } from 'react'
import { flushSync } from 'react-dom'
import { useSearchParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { getUserToken } from '@/lib/supabase'

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
    // Protect decimal points (e.g. 3.8/4.0, 0.5) so they aren't treated as sentence terminators
    const protected_ = para.replace(/(\d)\.(\d)/g, '$1\u00B7$2')
    const raw = protected_.match(/[^.!?]+[.!?]+["\u201d]?(?=\s|$)|[^.!?]+$/g) ?? [protected_]
    const matches = raw.map(s => s.replace(/\u00B7/g, '.'))
    return matches.map(s => s.trim()).filter(Boolean).filter(t => !/^\d+[%]?[.,]?$/.test(t)).map(t => ({ idx: idx++, text: t }))
  })
}

function parseZhSents(text: string): SentToken[][] {
  const paras = text.split(/\n\n+/).filter(p => p.trim())
  let idx = 0
  return paras.map(para => {
    const matches = para.match(/[^。！？]+[。！？]+|[^。！？]+$/g) ?? [para]
    return matches.map(s => s.trim()).filter(Boolean).map(t => ({ idx: idx++, text: t }))
  })
}

/** Map EN sentence at position enPos (within paragraph) to proportional ZH sentence position */
function enToZhPos(enPos: number, enCount: number, zhCount: number): number {
  if (zhCount === 0) return 0
  return Math.min(Math.round(enPos * zhCount / enCount), zhCount - 1)
}

/** Return the set of EN sentence positions that map to the given ZH position */
function zhToEnPositions(zhPos: number, enCount: number, zhCount: number): Set<number> {
  const s = new Set<number>()
  for (let i = 0; i < enCount; i++) {
    if (enToZhPos(i, enCount, zhCount) === zhPos) s.add(i)
  }
  return s
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
  const { messages, framework, draft, essayType, wordLimit, targetProgram, step1Summaries, setDraft } = useAppStore()

  const [text, setText] = useState(draft)
  const [reviseInput, setReviseInput] = useState('')
  const [isRevising, setIsRevising] = useState(false)
  const [reviseParagraphIdx, setReviseParagraphIdx] = useState<number | null>(null)
  const [generating, setGenerating] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [exportOpen, setExportOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const generatedRef = useRef(false)

  // Bilingual state
  const [showZh, setShowZh] = useState(false)
  const [zhText, setZhText] = useState('')
  const zhTextRef = useRef(zhText)
  const showZhRef = useRef(showZh)
  const [isTranslating, setIsTranslating] = useState(false)
  const [zhPanelWidth, setZhPanelWidth] = useState(320)
  const zhDragRef = useRef<{ startX: number; startW: number } | null>(null)

  // Inline quote-revise state
  const [quoteText, setQuoteText] = useState('')
  const [quoteRange, setQuoteRange] = useState<{ start: number; end: number } | null>(null)
  const reviseInputRef = useRef<HTMLInputElement>(null)
  const justQuotedRef = useRef(false)

  function handleTextareaMouseUp(e: React.MouseEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget
    const start = ta.selectionStart
    const end = ta.selectionEnd
    if (start === end) return
    const selected = text.slice(start, end)
    if (!selected.trim()) return
    setQuoteText(selected)
    setQuoteRange({ start, end })
    setReviseInput('')
    setTimeout(() => reviseInputRef.current?.focus(), 30)
  }

  function handleSentViewMouseUp() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return
    const selected = selection.toString().trim()
    if (!selected) return
    setQuoteText(selected)
    setQuoteRange(null) // will use indexOf to reconstruct
    setReviseInput('')
    selection.removeAllRanges()
    justQuotedRef.current = true
    setTimeout(() => reviseInputRef.current?.focus(), 30)
  }

  async function handleQuoteRevise() {
    if (!quoteText || !reviseInput.trim() || isRevising) return
    setIsRevising(true)
    // Snapshot original text and positions before streaming begins
    const originalText = text
    const capturedRange = quoteRange
    const capturedQuoteText = quoteText
    try {
      const res = await fetch('/api/revise', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft: capturedQuoteText, instruction: reviseInput, quoteMode: true }),
      })
      if (!res.ok) throw new Error('修改失败')
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let revised = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        revised += decoder.decode(value, { stream: true })
        // Stream into editor: replace the original selection with what's arrived so far
        const partial = capturedRange
          ? originalText.slice(0, capturedRange.start) + revised + originalText.slice(capturedRange.end)
          : originalText.replace(capturedQuoteText, revised)
        flushSync(() => setText(partial))
      }
      const finalText = capturedRange
        ? originalText.slice(0, capturedRange.start) + revised.trim() + originalText.slice(capturedRange.end)
        : originalText.replace(capturedQuoteText, revised.trim())
      setText(finalText)
      setDraft(finalText)
      setQuoteText('')
      setQuoteRange(null)
      setReviseInput('')

      // Partial ZH update: re-translate only affected paragraphs
      if (showZh && zhText) {
        const origParas = originalText.split(/\n\n+/)
        const qStart = capturedRange ? capturedRange.start : originalText.indexOf(capturedQuoteText)
        const qEnd = capturedRange ? capturedRange.end : qStart + capturedQuoteText.length
        let charPos = 0
        const affectedIdxs: number[] = []
        for (let i = 0; i < origParas.length; i++) {
          const pEnd = charPos + origParas[i].length
          if (pEnd > qStart && charPos < qEnd) affectedIdxs.push(i)
          charPos += origParas[i].length + 2
        }
        if (affectedIdxs.length > 0) {
          const newParas = finalText.split(/\n\n+/)
          const zhParas = zhText.split(/\n\n+/)
          await Promise.all(affectedIdxs.map(async (idx) => {
            if (!newParas[idx]) return
            try {
              const tr = await fetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newParas[idx] }),
              })
              if (tr.ok) {
                const data = await tr.json()
                if (data.translation?.trim()) zhParas[idx] = data.translation.trim()
              }
            } catch {}
          }))
          setZhText(zhParas.join('\n\n'))
        }
      }
    } catch (err) {
      console.error(err)
    } finally {
      setIsRevising(false)
    }
  }

  function onZhPanelDragStart(e: React.MouseEvent) {
    zhDragRef.current = { startX: e.clientX, startW: zhPanelWidth }
    function onMove(ev: MouseEvent) {
      if (!zhDragRef.current) return
      const delta = zhDragRef.current.startX - ev.clientX
      setZhPanelWidth(Math.max(200, Math.min(600, zhDragRef.current.startW + delta)))
    }
    function onUp() {
      zhDragRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Hover highlight — sentence-level with proportional cross-side mapping
  const [hoveredSent, setHoveredSent] = useState<{ para: number; side: 'en' | 'zh'; pos: number } | null>(null)
  // English edit mode toggle (bilingual view only)


  // Per-paragraph revision animation
  const [animatingParas, setAnimatingParas] = useState<Set<number>>(new Set())
  const [showParaView, setShowParaView] = useState(false)
  const prevTextRef = useRef<string>('')

  // Inline Chinese sentence editing
  const [editingZhIdx, setEditingZhIdx] = useState<number | null>(null)
  const [editingZhValue, setEditingZhValue] = useState('')
  // Which English sentence index is being updated after a zh edit (show pulse)
  const [updatingEnIdx, setUpdatingEnIdx] = useState<number | null>(null)
  // Which ZH sentence idx is being updated after an EN edit (show pulse)
  const [updatingZhIdx, setUpdatingZhIdx] = useState<number | null>(null)
  const editZhRef = useRef<HTMLTextAreaElement>(null)

  // Inline English sentence editing
  const [editingEnIdx, setEditingEnIdx] = useState<number | null>(null)
  const [editingEnValue, setEditingEnValue] = useState('')
  const editEnRef = useRef<HTMLTextAreaElement>(null)
  const committingEnRef = useRef(false)

  // Focus cursor at end only when a new sentence is opened for editing
  useEffect(() => {
    if (editingZhIdx !== null && editZhRef.current) {
      editZhRef.current.focus()
      const len = editZhRef.current.value.length
      editZhRef.current.setSelectionRange(len, len)
    }
  }, [editingZhIdx])

  useEffect(() => {
    if (editingEnIdx !== null && editEnRef.current) {
      editEnRef.current.focus()
      const len = editEnRef.current.value.length
      editEnRef.current.setSelectionRange(len, len)
    }
  }, [editingEnIdx])

  // Keep refs in sync so async callbacks always read the latest value
  zhTextRef.current = zhText
  showZhRef.current = showZh

  const enSentParas = parseEnSents(text)
  const zhSentParas = parseZhSents(zhText)

  const showSentView = showZh && !generating

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
        body: JSON.stringify({ summaries: step1Summaries, framework, essayType, targetProgram, wordLimit }),
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

    setHoveredSent(null)
    setEditingZhIdx(null)
    if (next && !zhText && text) translate(text)
  }

  function detectTargetParagraph(instruction: string, paragraphs: string[]): number | null {
    const numMap: Record<string, number> = {
      '一': 0, '1': 0, '二': 1, '2': 1, '三': 2, '3': 2,
      '四': 3, '4': 3, '五': 4, '5': 4, '六': 5, '6': 5,
      '七': 6, '7': 6, '八': 7, '8': 7,
    }
    const match = instruction.match(/第\s*([一二三四五六七八1-8])\s*(?:个\s*)?(?:段落?|部分)/)
    if (!match) return null
    const idx = numMap[match[1]]
    if (idx === undefined || idx >= paragraphs.length) return null
    return idx
  }

  /** Re-translate only the paragraphs at the given indices and patch zhText */
  async function retranslateParas(newParas: string[], changedIdxs: number[]) {
    // Use ref to get the latest zhText even after flushSync re-renders
    const zhParas = zhTextRef.current.split(/\n\n+/)
    await Promise.all(changedIdxs.map(async (idx) => {
      if (!newParas[idx]) return
      try {
        const tr = await fetch('/api/translate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: newParas[idx] }),
        })
        if (tr.ok) {
          const data = await tr.json()
          if (data.translation?.trim()) zhParas[idx] = data.translation.trim()
        }
      } catch {}
    }))
    setZhText(zhParas.join('\n\n'))
  }

  async function handleRevise() {
    const instruction = reviseInput.trim()
    if (!instruction || isRevising) return

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim())
    const paraIdx = detectTargetParagraph(instruction, paragraphs)

    setIsRevising(true)
    setShowParaView(false)
    setAnimatingParas(new Set())
    prevTextRef.current = text

    if (paraIdx !== null) {
      // Paragraph-specific revision: only rewrite the target paragraph
      setReviseParagraphIdx(paraIdx)
      try {
        const res = await fetch('/api/revise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft: paragraphs[paraIdx], instruction, paragraphMode: true }),
        })
        if (!res.ok) throw new Error('修改失败')
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let streamedPara = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          streamedPara += decoder.decode(value, { stream: true })
          const newParas = [...paragraphs]
          newParas[paraIdx] = streamedPara
          flushSync(() => setText(newParas.join('\n\n')))
        }
        const finalParas = [...paragraphs]
        finalParas[paraIdx] = streamedPara
        const finalText = finalParas.join('\n\n')
        setDraft(finalText)
        setReviseInput('')
        // Only re-translate the single revised paragraph
        if (showZhRef.current) {
          if (zhTextRef.current) {
            await retranslateParas(finalParas, [paraIdx])
          } else {
            translate(finalText)
          }
        }
        setAnimatingParas(new Set([paraIdx]))
        setShowParaView(true)
        setTimeout(() => { setShowParaView(false); setAnimatingParas(new Set()) }, 2500)
      } catch (err) {
        console.error(err)
      } finally {
        setIsRevising(false)
        setReviseParagraphIdx(null)
      }
      return
    }

    // Full-essay revision
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
        flushSync(() => setText(fullText))
      }
      setDraft(fullText)
      setReviseInput('')
      const oldParas = prevTextRef.current.split(/\n\n+/).filter(p => p.trim())
      const newParas = fullText.split(/\n\n+/).filter(p => p.trim())
      const changed = new Set<number>()
      for (let i = 0; i < Math.max(oldParas.length, newParas.length); i++) {
        if ((oldParas[i] ?? '') !== (newParas[i] ?? '')) changed.add(i)
      }
      // Only re-translate changed paragraphs
      if (showZhRef.current) {
        if (zhTextRef.current && changed.size > 0) {
          await retranslateParas(newParas, [...changed])
        } else {
          translate(fullText)
        }
      }
      if (changed.size > 0 && changed.size < newParas.length) {
        setAnimatingParas(changed)
        setShowParaView(true)
        setTimeout(() => { setShowParaView(false); setAnimatingParas(new Set()) }, 2500)
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

  async function handleSave() {
    if (!text || saving) return
    setSaving(true)
    try {
      // Parse school/program/degree from targetProgram ("School | Program | Degree")
      const parts = targetProgram.split('|').map(s => s.trim())
      const school = parts[0] || '未命名学校'
      const program = parts[1] || null
      const degree = parts[2] || null
      const token = getUserToken()
      const res = await fetch('/api/essays', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, school, program, degree, essay_type: essayType, en_text: text, zh_text: zhText || null }),
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || '保存失败')
      }
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (err) {
      console.error(err)
      alert('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  function startEditEn(sent: SentToken) {
    setEditingEnIdx(sent.idx)
    setEditingEnValue(sent.text)
    setHoveredSent(null)
  }

  async function commitEnEdit() {
    if (editingEnIdx === null || committingEnRef.current) return
    committingEnRef.current = true
    const rawValue = editEnRef.current ? editEnRef.current.value : editingEnValue
    const newSent = rawValue.trim()
    const savedEnIdx = editingEnIdx

    // Snapshot paragraph structure before async ops
    const currentEnParas = enSentParas
    const currentZhParas = zhSentParas

    const newEnParas = currentEnParas.map(para =>
      para.map(s => s.idx === savedEnIdx ? { ...s, text: newSent } : s)
    )
    const newFull = rejoinText(newEnParas, ' ')
    setText(newFull)
    setDraft(newFull)
    setEditingEnIdx(null)
    setEditingEnValue('')
    committingEnRef.current = false

    // Auto-update corresponding Chinese sentence
    if (showZh && currentZhParas.length > 0) {
      // Find which paragraph and position this EN sentence belongs to
      let paraIdx = -1, posInPara = -1
      for (let i = 0; i < currentEnParas.length; i++) {
        const pos = currentEnParas[i].findIndex(s => s.idx === savedEnIdx)
        if (pos !== -1) { paraIdx = i; posInPara = pos; break }
      }
      if (paraIdx !== -1 && currentZhParas[paraIdx]) {
        const zhCount = currentZhParas[paraIdx].length
        const enCount = currentEnParas[paraIdx].length
        const zhPos = enToZhPos(posInPara, enCount, zhCount)
        // End of the ZH range owned by this EN sentence (exclusive)
        const zhPosEnd = posInPara + 1 < enCount
          ? enToZhPos(posInPara + 1, enCount, zhCount)
          : zhCount
        const targetZhSent = currentZhParas[paraIdx][zhPos]
        if (targetZhSent) {
          if (!newSent) {
            // Sentence deleted — remove the entire corresponding ZH range
            const newZhParas = currentZhParas.map((para, pi) => {
              if (pi !== paraIdx) return para
              return [...para.slice(0, zhPos), ...para.slice(zhPosEnd)]
            })
            setZhText(rejoinText(newZhParas, ''))
          } else {
            // Sentence edited — translate to Chinese, replacing the whole ZH range
            setUpdatingZhIdx(targetZhSent.idx)
            try {
              const res = await fetch('/api/translate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: newSent, direction: 'en-zh' }),
              })
              if (res.ok) {
                const data = await res.json()
                const newZhSent = data.translation?.trim()
                if (newZhSent) {
                  const newZhParas = currentZhParas.map((para, pi) => {
                    if (pi !== paraIdx) return para
                    const replacement = { idx: targetZhSent.idx, text: newZhSent }
                    return [...para.slice(0, zhPos), replacement, ...para.slice(zhPosEnd)]
                  })
                  setZhText(rejoinText(newZhParas, ''))
                }
              }
            } catch (err) {
              console.error(err)
            } finally {
              setUpdatingZhIdx(null)
            }
          }
        }
      }
    }
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
            onClick={handleSave}
            disabled={!text || generating || saving}
            className="text-sm px-4 py-2 rounded-lg transition-colors border bg-orange-400 hover:bg-orange-500 text-white border-orange-400 disabled:opacity-40"
          >
            {saveSuccess ? '已保存 ✓' : saving ? '保存中…' : '保存文书'}
          </button>
          <Link href="/essays" className="text-sm px-4 py-2 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 border border-stone-200 transition-colors">
            我的文书
          </Link>
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

              {generating ? (
                <div className="flex-1 flex flex-col items-center justify-center">
                  <div className="w-12 h-12 rounded-full border-2 border-stone-500 border-t-transparent animate-spin mb-4" />
                  <p className="text-stone-500">正在生成初稿...</p>
                  <p className="text-stone-400 text-sm mt-1">约需 15-30 秒</p>
                </div>
              ) : showSentView ? (
                <div
                  className="flex-1 overflow-y-auto px-8 py-8 font-essay text-[15px] text-stone-800"
                  onMouseUp={handleSentViewMouseUp}
                  onClick={() => {
                    if (justQuotedRef.current) { justQuotedRef.current = false; return }
                    if (quoteText) { setQuoteText(''); setQuoteRange(null) }
                  }}
                >
                  {enSentParas.length > 0 ? enSentParas.map((sents, pi) => (
                    <p key={pi} className="mb-5">
                      {sents.map((sent, enPos) => (
                        editingEnIdx === sent.idx ? (
                          <textarea
                            key={sent.idx}
                            ref={editEnRef}
                            value={editingEnValue}
                            onChange={e => setEditingEnValue(e.target.value)}
                            onBlur={commitEnEdit}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitEnEdit() }
                              if (e.key === 'Escape') { setEditingEnIdx(null); setEditingEnValue('') }
                            }}
                            rows={2}
                            className="w-full rounded-lg px-2 py-1.5 text-[15px] leading-relaxed bg-stone-100 border border-stone-400 text-stone-900 resize-none focus:outline-none focus:border-stone-600 font-essay"
                          />
                        ) : (
                          <span
                            key={sent.idx}
                            className={`rounded px-0.5 py-0.5 transition-colors ${
                              updatingEnIdx === sent.idx
                                ? 'bg-stone-200 animate-pulse'
                                : quoteText && (quoteText.includes(sent.text.trim()) || sent.text.trim().includes(quoteText.trim()))
                                ? 'bg-amber-100 text-stone-900 ring-1 ring-amber-300'
                                : hoveredSent !== null && hoveredSent.para === pi && (
                                    (hoveredSent.side === 'en' && hoveredSent.pos === enPos) ||
                                    (hoveredSent.side === 'zh' && zhToEnPositions(hoveredSent.pos, sents.length, zhSentParas[pi]?.length ?? 1).has(enPos))
                                  )
                                ? 'bg-stone-200 text-stone-900'
                                : 'cursor-text hover:bg-stone-100'
                            }`}
                            onMouseEnter={() => editingZhIdx === null && setHoveredSent({ para: pi, side: 'en', pos: enPos })}
                            onMouseLeave={() => setHoveredSent(null)}
                            onClick={() => startEditEn(sent)}
                          >
                            {sent.text}{' '}
                          </span>
                        )
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
                      const isStreaming = isRevising && (reviseParagraphIdx !== null ? i === reviseParagraphIdx : i === streamParas.length - 1)
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
                  }}
                  onMouseUp={handleTextareaMouseUp}
                  placeholder="你的文书将在这里生成..."
                  className="flex-1 bg-transparent text-stone-800 text-[15px] p-8 resize-none focus:outline-none placeholder-stone-300 font-essay"
                  style={{ lineHeight: '1.85' }}
                />
              )}
            </div>

            {/* Chinese translation panel */}
            {showZh && (
              <div
                className="cursor-col-resize w-1.5 shrink-0 bg-stone-200 hover:bg-stone-400 active:bg-stone-500 transition-colors select-none"
                onMouseDown={onZhPanelDragStart}
              />
            )}
            {showZh && (
              <div className="border-stone-200 bg-stone-50 flex flex-col overflow-hidden shrink-0" style={{ width: zhPanelWidth }}>
                <div className="px-4 py-3 border-b border-stone-200 flex items-center justify-between shrink-0">
                  <span className="text-sm font-semibold text-stone-700">中文译文</span>
                  {isTranslating && <span className="text-xs text-stone-400">翻译中...</span>}
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
                          {sents.map((sent, zhPos) => (
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
                                  updatingZhIdx === sent.idx
                                    ? 'bg-stone-200 animate-pulse'
                                    : hoveredSent !== null && hoveredSent.para === pi && (
                                        (hoveredSent.side === 'zh' && hoveredSent.pos === zhPos) ||
                                        (hoveredSent.side === 'en' && enToZhPos(hoveredSent.pos, enSentParas[pi]?.length ?? 1, sents.length) === zhPos)
                                      )
                                    ? 'bg-stone-200 text-stone-900'
                                    : 'text-stone-700 hover:bg-stone-200'
                                }`}
                                onMouseEnter={() => editingZhIdx === null && setHoveredSent({ para: pi, side: 'zh', pos: zhPos })}
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
                    <p className="text-sm text-stone-400 text-center mt-8">译文将在此显示</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Revise bar */}
          <div className="border-t border-stone-200 px-4 pt-3 pb-4 shrink-0 bg-stone-50">
            {quoteText && (
              <div className="flex items-center gap-2 mb-2 px-1">
                <div className="flex items-center gap-2 bg-white border border-stone-200 rounded-lg px-3 py-1.5 text-xs text-stone-600 flex-1 min-w-0">
                  <span className="w-0.5 h-3.5 bg-stone-400 rounded-full shrink-0" />
                  <span className="truncate">{quoteText.trim().slice(0, 100)}{quoteText.trim().length > 100 ? '…' : ''}</span>
                </div>
                <button
                  onClick={() => { setQuoteText(''); setQuoteRange(null) }}
                  className="text-stone-400 hover:text-stone-600 text-xs shrink-0"
                >
                  ✕
                </button>
              </div>
            )}
            <div className="flex gap-3 items-center">
              <div className="w-7 h-7 rounded-lg bg-stone-900 flex items-center justify-center text-sm shrink-0 text-white">✦</div>
              <input
                ref={reviseInputRef}
                value={reviseInput}
                onChange={(e) => setReviseInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (quoteText ? handleQuoteRevise() : handleRevise())}
                placeholder={quoteText ? '如何修改这句话？' : '输入修改指令（例如：开篇改得更有冲击力；第三段加强技术细节）'}
                disabled={isRevising || generating}
                className="flex-1 bg-white border border-stone-200 rounded-xl px-4 py-2.5 text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-stone-400 disabled:opacity-50 transition-colors"
              />
              <button
                onClick={quoteText ? handleQuoteRevise : handleRevise}
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
