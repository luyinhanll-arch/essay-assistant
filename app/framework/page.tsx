'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import type { FrameworkSection, EssayType } from '@/lib/types'
import { ESSAY_TYPE_META } from '@/lib/types'

// ── SectionCard 组件 ──────────────────────────────────────────────────────────

function SectionCard({
  section,
  index,
  enabled,
  isDragging,
  isDragOver,
  onChange,
  onToggle,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  section: FrameworkSection
  index: number
  enabled: boolean
  isDragging: boolean
  isDragOver: boolean
  onChange: (updated: FrameworkSection) => void
  onToggle: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: () => void
  onDragEnd: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const [editingPoint, setEditingPoint] = useState<number | null>(null)

  function handlePointChange(i: number, value: string) {
    const next = [...section.keyPoints]
    next[i] = value
    onChange({ ...section, keyPoints: next })
  }

  function removePoint(i: number) {
    onChange({ ...section, keyPoints: section.keyPoints.filter((_, j) => j !== i) })
  }

  function addPoint() {
    onChange({ ...section, keyPoints: [...section.keyPoints, '新论点'] })
    setEditingPoint(section.keyPoints.length)
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      className={`border rounded-2xl overflow-hidden transition-all select-none ${
        isDragging
          ? 'opacity-40 scale-[0.98] shadow-none'
          : isDragOver
          ? 'border-stone-700 ring-1 ring-stone-200 shadow-md'
          : enabled
          ? 'bg-white border-stone-200 shadow-sm'
          : 'bg-stone-50 border-dashed border-stone-200'
      }`}
    >
      <div className="flex items-center gap-2.5 px-4 py-3">
        <div className="cursor-grab active:cursor-grabbing text-stone-300 hover:text-stone-500 shrink-0 text-base leading-none select-none transition-colors" title="拖拽调整顺序">⠿</div>
        <button
          onClick={onToggle}
          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
            enabled ? 'bg-stone-900 border-stone-900 text-white' : 'border-stone-300 hover:border-stone-400'
          }`}
        >
          {enabled && <span className="text-[10px] font-bold">✓</span>}
        </button>
        <div className={`w-6 h-6 rounded-md flex items-center justify-center text-xs font-bold shrink-0 transition-colors ${
          enabled ? 'bg-stone-100 text-stone-700' : 'bg-stone-100 text-stone-400'
        }`}>
          {index + 1}
        </div>
        <span className={`font-semibold text-sm flex-1 transition-colors ${enabled ? 'text-stone-900' : 'text-stone-400 line-through decoration-stone-300'}`}>
          {section.section}
        </span>
        {enabled && (
          <button onClick={() => setExpanded(!expanded)} className="text-stone-400 hover:text-stone-600 text-xs w-6 h-6 flex items-center justify-center transition-colors shrink-0">
            {expanded ? '▲' : '▼'}
          </button>
        )}
      </div>

      {enabled && expanded && (
        <div className="px-5 pb-5 border-t border-stone-100">
          <p className="text-xs text-stone-400 mt-4 mb-1.5">段落目的</p>
          <p className="text-sm text-stone-500 leading-relaxed bg-stone-50 rounded-lg px-3 py-2 mb-4">{section.purpose}</p>

          <div className="flex items-center gap-2 mb-2">
            <p className="text-xs text-stone-400">核心论点</p>
            <span className="text-xs text-stone-300">点击可编辑 · 可增删</span>
          </div>
          <ul className="space-y-1.5 mb-4">
            {section.keyPoints.map((pt, i) => (
              <li key={i} className="flex items-center gap-2 group">
                <span className="text-stone-400 text-xs shrink-0">·</span>
                {editingPoint === i ? (
                  <input
                    autoFocus
                    draggable={false}
                    value={pt}
                    onChange={(e) => handlePointChange(i, e.target.value)}
                    onBlur={() => setEditingPoint(null)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setEditingPoint(null) }}
                    className="flex-1 text-sm border border-stone-300 rounded-lg px-2 py-1 focus:outline-none focus:border-stone-500 bg-white"
                  />
                ) : (
                  <span
                    className="flex-1 text-sm text-stone-700 cursor-pointer hover:text-stone-900 py-1 rounded transition-colors"
                    onClick={() => setEditingPoint(i)}
                  >
                    {pt || <span className="text-stone-300 italic">点击编辑…</span>}
                  </span>
                )}
                <button onClick={() => removePoint(i)} className="opacity-0 group-hover:opacity-100 text-stone-300 hover:text-red-400 text-xs transition-all shrink-0">✕</button>
              </li>
            ))}
            <li>
              <button onClick={addPoint} className="text-xs text-stone-600 hover:text-stone-900 transition-colors mt-1 flex items-center gap-1">
                <span>+</span> 添加论点
              </button>
            </li>
          </ul>

          <p className="text-xs text-stone-400 mb-2">建议素材</p>
          <textarea
            draggable={false}
            value={section.suggestedContent}
            onChange={(e) => onChange({ ...section, suggestedContent: e.target.value })}
            className="w-full bg-stone-50 border border-stone-200 rounded-lg px-3 py-2 text-sm text-stone-700 resize-none focus:outline-none focus:border-stone-400 transition-colors"
            rows={3}
          />
        </div>
      )}
    </div>
  )
}

// ── 主页面 ────────────────────────────────────────────────────────────────────

export default function FrameworkPage() {
  const router = useRouter()
  const { messages, selectedPersona, targetProgram, framework, essayType, setFramework, setEssayType, setDraft } = useAppStore()

  const [step, setStep] = useState<'choose' | 'edit'>(framework.length > 0 ? 'edit' : 'choose')
  const [localEssayType, setLocalEssayType] = useState<EssayType>(essayType)
  const [schoolNotes, setSchoolNotes] = useState('')
  const [showSchoolNotes, setShowSchoolNotes] = useState(false)
  const [schoolUrl, setSchoolUrl] = useState('')
  const [isFetchingUrl, setIsFetchingUrl] = useState(false)
  const [fetchUrlError, setFetchUrlError] = useState('')

  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')

  const [sections, setSections] = useState<FrameworkSection[]>(framework)
  const [enabled, setEnabled] = useState<boolean[]>(() => framework.map(() => true))
  const [generating, setGenerating] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  useEffect(() => {
    if (messages.length === 0 && framework.length === 0) {
      router.replace('/interview')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Parse targetProgram: "UCLA/USC | Computer Science | MS"
  const programParts = targetProgram.split('|').map((s) => s.trim())
  const schools = programParts[0]
  const major = programParts[1]

  async function fetchSchoolInfo() {
    const url = schoolUrl.trim()
    if (!url) return
    setIsFetchingUrl(true)
    setFetchUrlError('')
    try {
      const res = await fetch('/api/school-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const data = await res.json()
      if (data.requirements) {
        setSchoolNotes((prev) => {
          const prefix = prev.trim() ? prev.trim() + '\n\n' : ''
          return prefix + `【来自：${url}】\n${data.requirements}`
        })
        setShowSchoolNotes(true)
      } else {
        setFetchUrlError(data.error || '提取失败，请尝试其他链接')
      }
    } catch {
      setFetchUrlError('网络错误，请重试')
    } finally {
      setIsFetchingUrl(false)
    }
  }

  function handleEssayTypeChange(t: EssayType) {
    setLocalEssayType(t)
    setEssayType(t)
  }

  async function generateFramework() {
    setAiLoading(true)
    setAiError('')

    const transcript = messages
      .map((m) => `${m.role === 'user' ? '申请者' : 'AI顾问'}: ${m.content}`)
      .join('\n\n')

    try {
      const res = await fetch('/api/framework', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          persona: selectedPersona,
          targetProgram,
          essayType: localEssayType,
          schoolNotes,
        }),
      })
      const data = await res.json()
      if (data.framework) {
        setFramework(data.framework)
        setSections(data.framework)
        setEnabled(data.framework.map(() => true))
        setStep('edit')
      } else {
        setAiError('生成失败，请重试')
      }
    } catch {
      setAiError('网络错误，请重试')
    } finally {
      setAiLoading(false)
    }
  }

  function moveSection(from: number, to: number) {
    if (to < 0 || to >= sections.length) return
    const nextSections = [...sections]
    const [movedSection] = nextSections.splice(from, 1)
    nextSections.splice(to, 0, movedSection)
    setSections(nextSections)

    const nextEnabled = [...enabled]
    const [movedEnabled] = nextEnabled.splice(from, 1)
    nextEnabled.splice(to, 0, movedEnabled)
    setEnabled(nextEnabled)
  }

  function toggleSection(index: number) {
    const next = [...enabled]
    next[index] = !next[index]
    setEnabled(next)
  }

  async function handleGenerateDraft() {
    const activeSections = sections.filter((_, i) => enabled[i])
    if (activeSections.length === 0) return

    setGenerating(true)
    setFramework(activeSections)
    setDraft('')

    router.push('/editor?generating=1')
  }

  const enabledCount = enabled.filter(Boolean).length

  return (
    <div className="min-h-screen bg-[#FAF9F6] text-stone-900">
      {/* ── 主导航 ── */}
      <header className="border-b border-stone-200 bg-[#FAF9F6] px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-orange-400 font-bold tracking-tight">EssayMind</Link>
          <div className="flex items-center gap-2 text-sm text-stone-400">
            <Link href="/interview" className="hover:text-stone-600 transition-colors">深度访谈</Link>
            <span>→</span>
            <Link href="/highlights" className="hover:text-stone-600 transition-colors">人设方向</Link>
            <span>→</span>
            <span className="text-stone-800 font-medium">框架</span>
            <span>→</span>
            <Link href="/editor" className="hover:text-stone-600 transition-colors">编辑</Link>
          </div>
        </div>
        <Link href="/highlights" className="text-xs text-stone-400 hover:text-stone-600 transition-colors">← 返回人设选择</Link>
      </header>

      {/* ── 子步骤指示器 ── */}
      <div className="border-b border-stone-200 bg-[#FAF9F6] py-3 flex justify-center">
        <div className="flex items-start gap-0">
          {/* Step 1 */}
          <div className="flex flex-col items-center w-28">
            {step === 'edit' ? (
              <button
                onClick={() => setStep('choose')}
                className="w-9 h-9 rounded-full bg-stone-900 hover:bg-stone-700 text-white text-sm font-bold flex items-center justify-center transition-colors"
              >✓</button>
            ) : (
              <div className="w-9 h-9 rounded-full bg-stone-900 text-white text-sm font-bold flex items-center justify-center">1</div>
            )}
            <span className={`mt-2 text-xs font-medium text-center leading-tight ${step === 'choose' ? 'text-stone-800' : 'text-stone-400'}`}>
              配置框架
            </span>
          </div>
          {/* Track */}
          <div className="mt-[18px] w-20 h-0.5 bg-stone-200 relative mx-1 shrink-0">
            <div className={`absolute inset-y-0 left-0 bg-stone-500 transition-all duration-500 ${step === 'edit' ? 'w-full' : 'w-0'}`} />
          </div>
          {/* Step 2 */}
          <div className="flex flex-col items-center w-28">
            <div className={`w-9 h-9 rounded-full text-sm font-bold flex items-center justify-center transition-all duration-300 ${
              step === 'edit' ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-400'
            }`}>2</div>
            <span className={`mt-2 text-xs font-medium text-center leading-tight ${step === 'edit' ? 'text-stone-800' : 'text-stone-400'}`}>
              调整框架
            </span>
          </div>
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-8 py-12">

        {/* ── 步骤一：生成框架 ─────────────────────────────────────── */}
        {step === 'choose' && (
          <>
            <div className="mb-10">
              <h1 className="text-xl font-semibold text-stone-900 mb-2">生成文书框架</h1>
              <p className="text-sm text-stone-400">基于你的访谈亮点和学校偏好，AI 生成专属段落结构</p>
            </div>

            {/* ── 文书类型选择 ── */}
            <div className="bg-white border border-stone-200 rounded-2xl p-6 mb-5">
              <h2 className="text-sm font-semibold text-stone-700 mb-4">1. 文书类型 <span className="text-red-400">*</span></h2>
              <div className="grid grid-cols-2 gap-4">
                {(Object.keys(ESSAY_TYPE_META) as EssayType[]).map((type) => {
                  const meta = ESSAY_TYPE_META[type]
                  const active = localEssayType === type
                  return (
                    <button
                      key={type}
                      onClick={() => handleEssayTypeChange(type)}
                      className={`flex items-start gap-4 p-4 rounded-xl border transition-all text-left ${
                        active ? 'border-stone-900 bg-stone-50 shadow-sm' : 'border-stone-200 hover:border-stone-300 bg-white'
                      }`}
                    >
                      <span className="text-3xl shrink-0">{meta.icon}</span>
                      <div>
                        <div className={`font-semibold text-base mb-1 ${active ? 'text-stone-900' : 'text-stone-900'}`}>{meta.label}</div>
                        <div className="text-xs text-stone-400 leading-snug">{meta.desc}</div>
                      </div>
                      {active && <span className="ml-auto text-stone-700 text-lg shrink-0">✓</span>}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* ── 人设方向 ── */}
            <div className="bg-white border border-stone-200 rounded-2xl p-6 mb-5">
              <h2 className="text-sm font-semibold text-stone-700 mb-1">2. 人设方向</h2>
              <p className="text-xs text-stone-400 mb-4">AI 将围绕这个叙事角度构建文书框架</p>
              {selectedPersona ? (
                <div className="p-4 bg-stone-50 border border-stone-200 rounded-xl">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-6 h-6 rounded-md bg-stone-900 text-white text-xs flex items-center justify-center font-bold">{selectedPersona.id}</span>
                    <p className="font-semibold text-stone-900">{selectedPersona.title}</p>
                    <span className="text-xs text-stone-600 bg-stone-100 px-2 py-0.5 rounded-full">{selectedPersona.tagline}</span>
                  </div>
                  <p className="text-sm text-stone-600 leading-relaxed mb-2">{selectedPersona.description}</p>
                  <p className="text-xs text-stone-700"><span className="font-medium">侧重：</span>{selectedPersona.focus}</p>
                </div>
              ) : (
                <div className="flex items-center gap-3 p-4 bg-stone-50 border border-stone-200 rounded-xl">
                  <span className="text-stone-400 text-xl">⚠️</span>
                  <div>
                    <p className="text-sm text-stone-700 font-medium">尚未选择人设方向</p>
                    <p className="text-xs text-stone-400 mt-0.5">先完成人设选择，AI 才能生成有针对性的框架</p>
                  </div>
                  <Link href="/highlights" className="ml-auto shrink-0 text-xs bg-stone-900 hover:bg-stone-800 text-white px-3 py-1.5 rounded-lg font-medium transition-all">去选择 →</Link>
                </div>
              )}
            </div>

            {/* ── 学校偏好（可选） ── */}
            <div className="bg-white border border-stone-200 rounded-2xl p-6 mb-6">
              <div className="flex items-center justify-between mb-1">
                <h2 className="text-sm font-semibold text-stone-700">3. 学校偏好 / 要求 <span className="text-stone-400 font-normal text-xs">（可选，影响框架侧重）</span></h2>
                {targetProgram && (
                  <div className="flex gap-1.5">
                    {schools && <span className="bg-stone-50 border border-stone-200 text-stone-600 text-xs px-2 py-0.5 rounded-full">{schools}</span>}
                    {major && <span className="bg-blue-50 border border-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{major}</span>}
                  </div>
                )}
              </div>
              <p className="text-xs text-stone-400 mb-4">粘贴学校官网链接自动提取要求，或手动填写</p>

              {/* URL fetch */}
              <div className="flex gap-2 mb-3">
                <input
                  value={schoolUrl}
                  onChange={(e) => { setSchoolUrl(e.target.value); setFetchUrlError('') }}
                  onKeyDown={(e) => e.key === 'Enter' && fetchSchoolInfo()}
                  placeholder="https://… (admissions 页 / GradCafe / Reddit)"
                  className="flex-1 bg-stone-50 border border-stone-200 rounded-xl px-3 py-2 text-sm text-stone-700 placeholder-stone-400 focus:outline-none focus:border-stone-400 transition-colors min-w-0"
                />
                <button
                  onClick={fetchSchoolInfo}
                  disabled={isFetchingUrl || !schoolUrl.trim()}
                  className="shrink-0 bg-stone-900 hover:bg-stone-800 disabled:opacity-40 text-white text-sm px-4 py-2 rounded-xl font-medium transition-all whitespace-nowrap"
                >
                  {isFetchingUrl ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      提取中
                    </span>
                  ) : '自动提取'}
                </button>
              </div>
              {fetchUrlError && <p className="text-xs text-red-500 mb-2">{fetchUrlError}</p>}

              <textarea
                value={schoolNotes}
                onChange={(e) => setSchoolNotes(e.target.value)}
                placeholder="例如：该项目注重工业界实习经历；字数限制 500 词；希望申请者有完整项目经历…"
                rows={3}
                className="w-full bg-stone-50 border border-stone-200 rounded-xl px-4 py-3 text-sm text-stone-700 placeholder-stone-400 resize-none focus:outline-none focus:border-stone-400 transition-colors"
              />
            </div>

            {/* ── 生成按钮 ── */}
            <div className="text-center">
              {aiError && <p className="text-sm text-red-500 mb-3">{aiError}</p>}
              <button
                onClick={generateFramework}
                disabled={aiLoading || !selectedPersona}
                className="bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white font-medium text-base px-10 py-4 rounded-2xl transition-colors"
              >
                {aiLoading ? (
                  <span className="flex items-center gap-2">
                    <span className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    AI 生成中…
                  </span>
                ) : `生成 ${localEssayType} 专属框架 →`}
              </button>
              <p className="text-xs text-stone-400 mt-3">
                {selectedPersona ? `人设：${selectedPersona.title}` : '请先选择人设方向'}{schoolNotes.trim() ? ' · 已加入学校偏好' : ''}
              </p>
            </div>
          </>
        )}

        {/* ── 步骤二：编辑框架 ─────────────────────────────────────── */}
        {step === 'edit' && (
          <>
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-stone-900 mb-1">调整你的文书框架</h1>
              <p className="text-sm text-stone-400">勾选/取消段落 · 拖拽 ⠿ 调整顺序 · 点击论点可直接编辑</p>
            </div>

            {/* Context summary bar */}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-6 text-xs text-stone-400">
              <span>框架基于：</span>
              <span className="font-medium text-stone-600">{ESSAY_TYPE_META[localEssayType].icon} {localEssayType}</span>
              {targetProgram && <span className="text-stone-500">{schools}{major ? ` · ${major}` : ''}</span>}
              {selectedPersona && <span className="text-stone-500">{selectedPersona.title}</span>}
            </div>

            <div className="space-y-3 mb-8">
              {sections.map((s, i) => (
                <SectionCard
                  key={i}
                  section={s}
                  index={i}
                  enabled={enabled[i]}
                  isDragging={dragIndex === i}
                  isDragOver={dragOverIndex === i && dragIndex !== i}
                  onChange={(updated) => {
                    const next = [...sections]
                    next[i] = updated
                    setSections(next)
                  }}
                  onToggle={() => toggleSection(i)}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => { e.preventDefault(); if (dragIndex !== i) setDragOverIndex(i) }}
                  onDrop={() => {
                    if (dragIndex !== null && dragIndex !== i) moveSection(dragIndex, i)
                    setDragIndex(null)
                    setDragOverIndex(null)
                  }}
                  onDragEnd={() => { setDragIndex(null); setDragOverIndex(null) }}
                />
              ))}
            </div>

            <div className="border-t border-stone-200 pt-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <Link href="/highlights" className="text-sm text-stone-400 hover:text-stone-600 transition-colors">← 返回人设</Link>
                {enabledCount === 0 && <p className="text-xs text-red-400">请至少保留一个段落</p>}
              </div>
              <button
                onClick={handleGenerateDraft}
                disabled={generating || enabledCount === 0}
                className="bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white font-medium px-7 py-3 rounded-xl text-sm transition-colors"
              >
                {generating ? '跳转中…' : `确认框架（${enabledCount} 段），生成初稿 →`}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
