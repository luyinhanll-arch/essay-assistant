'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useAppStore } from '@/lib/store'
import { INTERVIEW_DIMENSIONS } from '@/lib/types'
import type { Persona } from '@/lib/types'

// ─── Persona card ─────────────────────────────────────────────────────────────

const PERSONA_COLORS = ['violet', 'indigo', 'purple'] as const
type Color = typeof PERSONA_COLORS[number]

const COLOR_STYLES: Record<Color, {
  border: string; bg: string; badge: string; tag: string; dot: string
}> = {
  violet: {
    border: 'border-stone-400 ring-1 ring-stone-200',
    bg: 'bg-stone-50',
    badge: 'bg-stone-900 text-white',
    tag: 'bg-stone-100 text-stone-600',
    dot: 'bg-stone-500',
  },
  indigo: {
    border: 'border-stone-400 ring-1 ring-stone-200',
    bg: 'bg-stone-50',
    badge: 'bg-stone-900 text-white',
    tag: 'bg-stone-100 text-stone-600',
    dot: 'bg-stone-500',
  },
  purple: {
    border: 'border-stone-400 ring-1 ring-stone-200',
    bg: 'bg-stone-50',
    badge: 'bg-stone-900 text-white',
    tag: 'bg-stone-100 text-stone-600',
    dot: 'bg-stone-500',
  },
}


function PersonaCard({ persona, color, selected, onSelect }: {
  persona: Persona; color: Color; selected: boolean; onSelect: () => void
}) {
  const c = COLOR_STYLES[color]
  const lines = persona.evidence.split('\n').map(l => l.replace(/^·\s*/, '').trim()).filter(Boolean)

  return (
    <div
      onClick={!selected ? onSelect : undefined}
      className={`rounded-xl border p-5 transition-all ${
        selected ? `${c.border} ${c.bg}` : 'border-stone-200 bg-white hover:border-stone-300 cursor-pointer'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 min-w-0 mb-3">
        <span className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold shrink-0 ${selected ? c.badge : 'bg-stone-100 text-stone-500'}`}>
          {persona.id}
        </span>
        <div className="min-w-0">
          <h3 className="font-bold text-stone-900 text-base truncate">{persona.title}</h3>
          <p className={`text-xs mt-0.5 font-medium ${selected ? 'text-stone-600' : 'text-stone-400'}`}>
            {persona.tagline}
          </p>
        </div>
      </div>

      <p className="text-sm text-stone-600 leading-relaxed mb-4">{persona.description}</p>

      {/* Evidence section */}
      <div className={`rounded-xl p-3 mb-3 ${selected ? 'bg-white/60' : 'bg-stone-50'}`}>
        <p className="text-[10px] text-stone-400 font-medium mb-1.5">支撑你的经历</p>
        <ul className="space-y-1">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-stone-500 leading-relaxed">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${selected ? c.dot : 'bg-stone-300'}`} />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className={`text-xs rounded-lg px-3 py-2 ${selected ? c.tag : 'bg-stone-50 text-stone-400'}`}>
        <span className="font-medium">文书侧重：</span>{persona.focus}
      </div>
    </div>
  )
}

// ─── Experience card ──────────────────────────────────────────────────────────

const DIM_ICONS: Record<string, string> = {
  academic: '🎓', project: '💻', internship: '🏢',
  research: '🔬', motivation: '🎯', plan: '🗺️',
}

// Rendered as pairs (side-by-side when both present)
const PAIRED_ROWS = [['motivation', 'plan']]
const CONFIRM_EXP_ORDER = ['research', 'internship', 'project']
// Per-section editing: each experience is a named entry
const MULTI_ENTRY_DIMS = ['project', 'internship', 'research']

/** Parse summary into sections. A section starts with a `# Title` line. */
function parseSections(summary: string): { title: string | null; bullets: string[] }[] {
  const lines = summary.split('\n').map(l => l.trim()).filter(Boolean)
  const sections: { title: string | null; bullets: string[] }[] = []
  let current: { title: string | null; bullets: string[] } = { title: null, bullets: [] }

  for (const line of lines) {
    if (line.startsWith('# ')) {
      if (current.bullets.length > 0 || current.title !== null) sections.push(current)
      current = { title: line.slice(2).trim(), bullets: [] }
    } else {
      current.bullets.push(line.replace(/^[·•]\s*/, ''))
    }
  }
  if (current.bullets.length > 0 || current.title !== null) sections.push(current)
  return sections.length > 0 ? sections : [{ title: null, bullets: lines }]
}

type Section = { title: string | null; bullets: string[] }

function serializeSections(sections: Section[]): string {
  return sections
    .map(sec => {
      const lines: string[] = []
      if (sec.title) lines.push(`# ${sec.title}`)
      sec.bullets.forEach(b => lines.push(`· ${b}`))
      return lines.join('\n')
    })
    .filter(s => s.length > 0)
    .join('\n\n')
}

function SummaryContent({ summary }: { summary: string }) {
  const sections = parseSections(summary)
  const isMultiSection = sections[0]?.title !== null

  if (isMultiSection) {
    return (
      <div className="space-y-4">
        {sections.map((sec, si) => (
          <div key={si}>
            {sec.title && (
              <p className="text-xs font-semibold text-stone-700 mb-1.5 flex items-center gap-1.5">
                <span className="w-1 h-3 rounded-full bg-stone-400 inline-block" />
                {sec.title}
              </p>
            )}
            <ul className="space-y-1.5 pl-3.5">
              {sec.bullets.map((b, bi) => (
                <li key={bi} className="flex items-start gap-2">
                  <span className="mt-1.5 w-1 h-1 rounded-full bg-stone-300 shrink-0" />
                  <span className="text-xs text-stone-600 leading-relaxed">{b}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    )
  }

  const bullets = sections[0]?.bullets ?? []
  if (bullets.length >= 1) {
    return (
      <ul className="space-y-1.5">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-stone-300 shrink-0" />
            <span className="text-xs text-stone-600 leading-relaxed">{b}</span>
          </li>
        ))}
      </ul>
    )
  }
  return <p className="text-xs text-stone-600 leading-relaxed">{summary}</p>
}

/** Count distinct named sections in a summary string */
function countSections(summary: string): number {
  if (!summary) return 0
  const sections = parseSections(summary)
  return sections[0]?.title !== null ? sections.length : 0
}

// ─── Multi-entry card (project / internship / research) ───────────────────────

const TITLE_PLACEHOLDER: Record<string, string> = {
  project:    '项目名称（如：毕业设计、竞赛项目）',
  internship: '公司名称（如：字节跳动）',
  research:   '研究机构 / 课题名称',
}
const ADD_LABEL: Record<string, string> = {
  project: '项目', internship: '实习', research: '科研',
}

function SectionView({ sec, onEdit, onDelete }: {
  sec: Section; onEdit: () => void; onDelete: () => void
}) {
  return (
    <div className="group">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        {sec.title ? (
          <p className="text-xs font-semibold text-stone-700 flex items-center gap-1.5 min-w-0">
            <span className="w-1 h-3 rounded-full bg-stone-400 inline-block shrink-0" />
            <span className="truncate">{sec.title}</span>
          </p>
        ) : <div />}
        <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
          <button onClick={onEdit} className="text-[11px] text-stone-400 hover:text-stone-700 transition-colors">编辑</button>
          <span className="text-stone-200 text-xs">|</span>
          <button onClick={onDelete} className="text-[11px] text-stone-400 hover:text-red-400 transition-colors">删除</button>
        </div>
      </div>
      <ul className="space-y-1.5 pl-3.5">
        {sec.bullets.map((b, bi) => (
          <li key={bi} className="flex items-start gap-2">
            <span className="mt-1.5 w-1 h-1 rounded-full bg-stone-300 shrink-0" />
            <span className="text-xs text-stone-600 leading-relaxed">{b}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SectionEditor({ titlePlaceholder, draftTitle, setDraftTitle, draftContent, setDraftContent, onSave, onCancel }: {
  titlePlaceholder: string
  draftTitle: string; setDraftTitle: (v: string) => void
  draftContent: string; setDraftContent: (v: string) => void
  onSave: () => void; onCancel: () => void
}) {
  return (
    <div className="bg-stone-50 rounded-xl p-3">
      <input
        value={draftTitle}
        onChange={e => setDraftTitle(e.target.value)}
        placeholder={titlePlaceholder}
        className="w-full text-xs font-semibold text-stone-700 bg-white border border-stone-200 rounded-lg px-3 py-2 mb-2 focus:outline-none focus:border-stone-400"
      />
      <textarea
        value={draftContent}
        onChange={e => setDraftContent(e.target.value)}
        rows={4}
        placeholder="每行一个要点，描述你做了什么、怎么做的、有什么成果"
        className="w-full text-xs text-stone-700 bg-white border border-stone-200 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:border-stone-400 leading-relaxed"
        autoFocus
      />
      <div className="flex gap-2 mt-2 justify-end">
        <button onClick={onCancel} className="text-xs text-stone-400 hover:text-stone-600 px-3 py-1.5">取消</button>
        <button onClick={onSave} className="text-xs font-medium text-white bg-stone-900 hover:bg-stone-800 px-3 py-1.5 rounded-lg transition-colors">保存</button>
      </div>
    </div>
  )
}

function MultiEntryCard({ dimKey, label, summary, loading = false, onSave }: {
  dimKey: string; label: string; summary: string
  loading?: boolean
  onSave: (value: string) => void
}) {
  const [sections, setSections] = useState<Section[]>(() =>
    parseSections(summary).filter(s => s.title !== null || s.bullets.length > 0)
  )
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')

  useEffect(() => {
    setSections(parseSections(summary).filter(s => s.title !== null || s.bullets.length > 0))
  }, [summary])

  function startEdit(idx: number) {
    const sec = sections[idx]
    setDraftTitle(sec.title ?? '')
    setDraftContent(sec.bullets.join('\n'))
    setEditingIdx(idx)
  }

  function startAdd() {
    setDraftTitle(''); setDraftContent('')
    setEditingIdx(sections.length)
  }

  function commit(idx: number) {
    const bullets = draftContent.split('\n').map(l => l.trim().replace(/^[·•]\s*/, '')).filter(Boolean)
    const updated: Section = { title: draftTitle.trim() || null, bullets }
    const newSecs = idx === sections.length
      ? [...sections, updated]
      : sections.map((s, i) => i === idx ? updated : s)
    setSections(newSecs)
    onSave(serializeSections(newSecs))
    setEditingIdx(null)
  }

  function remove(idx: number) {
    const newSecs = sections.filter((_, i) => i !== idx)
    setSections(newSecs)
    onSave(serializeSections(newSecs))
    if (editingIdx !== null && editingIdx >= idx) setEditingIdx(null)
  }

  const isAdding = editingIdx === sections.length

  return (
    <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-base leading-none shrink-0">{DIM_ICONS[dimKey]}</span>
          <span className="font-semibold text-sm text-stone-800 truncate">{label}</span>
          {sections.length > 1 && (
            <span className="text-[10px] font-semibold text-stone-500 bg-stone-100 border border-stone-200 px-1.5 py-0.5 rounded-full shrink-0">
              {sections.length} 段
            </span>
          )}
        </div>
      </div>
      <div className="h-px bg-stone-100 mx-5" />

      <div className="px-5 pt-4 pb-3 space-y-4">
        {loading ? (
          <div className="flex items-center gap-2 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-pulse shrink-0" />
            <p className="text-xs text-stone-400">AI 正在整理…</p>
          </div>
        ) : (
          <>
            {sections.length === 0 && !isAdding && (
              <p className="text-xs text-stone-400 italic">暂无内容，点击下方添加经历</p>
            )}
            {sections.map((sec, idx) => (
              <div key={idx}>
                {editingIdx === idx ? (
                  <SectionEditor
                    titlePlaceholder={TITLE_PLACEHOLDER[dimKey] ?? '经历名称'}
                    draftTitle={draftTitle} setDraftTitle={setDraftTitle}
                    draftContent={draftContent} setDraftContent={setDraftContent}
                    onSave={() => commit(idx)}
                    onCancel={() => setEditingIdx(null)}
                  />
                ) : (
                  <SectionView sec={sec} onEdit={() => startEdit(idx)} onDelete={() => remove(idx)} />
                )}
              </div>
            ))}
            {isAdding && (
              <SectionEditor
                titlePlaceholder={TITLE_PLACEHOLDER[dimKey] ?? '经历名称'}
                draftTitle={draftTitle} setDraftTitle={setDraftTitle}
                draftContent={draftContent} setDraftContent={setDraftContent}
                onSave={() => commit(sections.length)}
                onCancel={() => setEditingIdx(null)}
              />
            )}
          </>
        )}
      </div>

      {!loading && editingIdx === null && (
        <div className="px-5 pb-4">
          <button
            onClick={startAdd}
            className="w-full text-xs text-stone-400 hover:text-stone-700 border border-dashed border-stone-200 hover:border-stone-300 rounded-xl py-2.5 transition-colors flex items-center justify-center gap-1.5"
          >
            + 添加{ADD_LABEL[dimKey] ?? ''}经历
          </button>
        </div>
      )}
    </div>
  )
}

function ExperienceCard({ dimKey, label, summary, isCovered, onSave }: {
  dimKey: string; label: string; summary: string
  isCovered: boolean
  onSave: (value: string) => void
}) {
  const hasContent = isCovered
  const sectionCount = hasContent ? countSections(summary) : 0
  const [editing, setEditing] = useState(false)
  const [draft, setDraft]     = useState(summary)

  useEffect(() => { setDraft(summary) }, [summary])

  function handleSave()   { onSave(draft.trim()); setEditing(false) }
  function handleCancel() { setDraft(summary); setEditing(false) }

  return (
    <div className={`bg-white rounded-2xl flex flex-col transition-all overflow-hidden ${
      hasContent
        ? 'border border-stone-200'
        : 'border border-dashed border-stone-200'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-base leading-none shrink-0">{DIM_ICONS[dimKey]}</span>
          <span className={`font-semibold text-sm truncate ${hasContent ? 'text-stone-800' : 'text-stone-400'}`}>
            {label}
          </span>
          {sectionCount > 1 && (
            <span className="text-[10px] font-semibold text-stone-500 bg-stone-100 border border-stone-200 px-1.5 py-0.5 rounded-full shrink-0">
              {sectionCount} 段
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {hasContent && summary && !editing && (
            <button
              onClick={() => { setDraft(summary); setEditing(true) }}
              className="text-[11px] text-stone-400 hover:text-stone-700 transition-colors"
            >
              编辑
            </button>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="h-px bg-stone-100 mx-5" />

      {/* Body */}
      <div className="px-5 pb-5 pt-4 flex-1">
        {hasContent ? (
          editing ? (
            <>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                rows={5}
                className="w-full text-xs text-stone-700 bg-stone-50 border border-stone-200 rounded-xl px-3 py-2.5 resize-none focus:outline-none focus:border-stone-400 leading-relaxed"
                autoFocus
              />
              <div className="flex gap-2 mt-2.5 justify-end">
                <button onClick={handleCancel} className="text-xs text-stone-400 hover:text-stone-600 px-3 py-1.5">取消</button>
                <button onClick={handleSave} className="text-xs font-medium text-white bg-stone-900 hover:bg-stone-800 px-3 py-1.5 rounded-lg transition-colors">保存</button>
              </div>
            </>
          ) : summary ? (
            <SummaryContent summary={summary} />
          ) : (
            <div className="flex items-center gap-2 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-stone-300 animate-pulse shrink-0" />
              <p className="text-xs text-stone-400">AI 正在整理…</p>
            </div>
          )
        ) : (
          <p className="text-xs text-stone-300 italic">访谈中未覆盖此项</p>
        )}
      </div>
    </div>
  )
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

function Nav({ step, onGoStep1, onGoStep2 }: { step: 1 | 2; onGoStep1: () => void; onGoStep2?: () => void }) {
  return (
    <div className="shrink-0">
      <header className="border-b border-stone-200 bg-[#FAF9F6] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-orange-400 font-bold tracking-tight">EssayMind</Link>
          <div className="flex items-center gap-2 text-sm text-stone-400">
            <Link href="/interview" className="hover:text-stone-600 transition-colors">深度访谈</Link>
            <span>→</span>
            <span className="text-stone-800 font-medium">人设方向</span>
            <span>→</span>
            <Link href="/framework" className="hover:text-stone-600 transition-colors">框架</Link>
            <span>→</span>
            <Link href="/editor" className="hover:text-stone-600 transition-colors">编辑</Link>
          </div>
        </div>
        <Link href="/interview" className="text-xs text-stone-400 hover:text-stone-600 transition-colors">← 返回访谈</Link>
      </header>

      {/* Step indicator */}
      <div className="border-b border-stone-200 bg-[#FAF9F6] py-3 flex justify-center">
        <div className="flex items-start gap-0">

          {/* Step 1 */}
          <div className="flex flex-col items-center w-28">
            {step === 2 ? (
              <button
                onClick={onGoStep1}
                className="w-9 h-9 rounded-full bg-stone-900 hover:bg-stone-800 text-white text-sm font-bold flex items-center justify-center transition-colors shadow-sm"
              >1</button>
            ) : (
              <div className="w-9 h-9 rounded-full bg-stone-900 text-white text-sm font-bold flex items-center justify-center shadow-sm">1</div>
            )}
            <span className={`mt-2 text-xs font-medium text-center leading-tight ${step === 1 ? 'text-stone-800' : 'text-stone-400'}`}>
              确认经历
            </span>
          </div>

          {/* Track */}
          <div className="mt-[18px] w-20 h-0.5 bg-stone-200 relative mx-1 shrink-0">
            <div className={`absolute inset-y-0 left-0 bg-stone-500 transition-all duration-500 ${step === 2 ? 'w-full' : 'w-0'}`} />
          </div>

          {/* Step 2 */}
          <div className="flex flex-col items-center w-28">
            {step === 1 && onGoStep2 ? (
              <button
                onClick={onGoStep2}
                className="w-9 h-9 rounded-full bg-stone-100 hover:bg-stone-900 text-stone-500 hover:text-white text-sm font-bold flex items-center justify-center transition-all duration-200 shadow-sm"
              >2</button>
            ) : (
              <div className={`w-9 h-9 rounded-full text-sm font-bold flex items-center justify-center transition-all duration-300 ${
                step === 2
                  ? 'bg-stone-900 text-white shadow-sm'
                  : 'bg-stone-100 text-stone-400'
              }`}>2</div>
            )}
            <span className={`mt-2 text-xs font-medium text-center leading-tight ${step === 2 ? 'text-stone-800' : 'text-stone-400'}`}>
              选择叙事方向
            </span>
          </div>

        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PersonaPage() {
  const router = useRouter()
  const {
    messages, personas, selectedPersona,
    emptyDimensions, coveredDimensions, interviewComplete,
    step1Summaries, setStep1Summary,
    dimensionSummaries,
    cvText, cvAnalysis, quickInfo,
    setPersonas, setSelectedPersona, setFramework,
  } = useAppStore()

  const [step, setStep]       = useState<1 | 2>(personas.length > 0 ? 2 : 1)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const [paragraphLoading, setParagraphLoading] = useState<Record<string, boolean>>({})

  // The completed interview page may recover a dimension from direct Q&A even
  // when an older progress event omitted it. A non-empty structured summary is
  // durable evidence that the dimension was actually collected, so confirmation
  // must not hide that card merely because coveredDimensions lagged behind.
  const activeDimensionKeys = new Set(INTERVIEW_DIMENSIONS.map(dimension => dimension.key))
  const confirmationCoveredDimensions = Array.from(new Set([
    ...coveredDimensions,
    ...(interviewComplete
      ? Object.entries(dimensionSummaries)
          .filter(([, summary]) => summary.trim() && !/^(?:#\s*)?(?:无|暂无|没有)/.test(summary.trim()))
          .map(([dimension]) => dimension)
      : []),
  ])).filter(dimension => activeDimensionKeys.has(dimension))

  // CV analysis owns classification. Later summaries may enrich wording, but may
  // never move an item between research / internship / project.
  const cvExperienceEntries = (() => {
    const entries: Array<{ name: string; type: string }> = []
    let current: { name: string; type: string } | null = null
    for (const raw of cvAnalysis.split('\n')) {
      const line = raw.trim()
      if (/^经历名称[：:]/.test(line)) {
        if (current) entries.push(current)
        current = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '' }
      } else if (/^经历类型[：:]/.test(line) && current) {
        current.type = line.replace(/^经历类型[：:]/, '').trim()
      }
    }
    if (current) entries.push(current)
    return entries
  })()
  const dimensionType: Record<string, string> = {
    research: '科研经历', internship: '实习经历', project: '项目经历',
  }
  const normalizeExperienceTitle = (value: string) =>
    value.toLowerCase().replace(/[\s\-_"“”'‘’「」【】《》()（）·•,，.。]/g, '')
  const fixedNamesForDimension = (dimension: string) =>
    cvExperienceEntries.filter(entry => entry.type === dimensionType[dimension]).map(entry => entry.name)
  const summaryForDimension = (dimension: string) => {
    const summary = step1Summaries[dimension] || ''
    if (!MULTI_ENTRY_DIMS.includes(dimension)) return summary

    // For no-CV interviews the sidebar structured summary is the canonical
    // experience list. A detailed summary may have been generated and cached
    // before the final experience was discovered, so merge any missing entries
    // locally instead of showing inconsistent counts (and without resending the
    // full interview to the summarisation service).
    if (!cvText) {
      const detailedSections = parseSections(summary).filter(section => section.title || section.bullets.length > 0)
      const structuredSections = parseSections(dimensionSummaries[dimension] || '')
        .filter(section => section.title || section.bullets.length > 0)
      if (structuredSections.length === 0) return summary

      const titleScore = (candidate: string, canonical: string) => {
        const a = normalizeExperienceTitle(candidate)
        const b = normalizeExperienceTitle(canonical)
        if (!a || !b) return 0
        if (a === b) return 1
        if (a.includes(b) || b.includes(a)) return 0.95
        const shorter = a.length <= b.length ? a : b
        const longer = a.length <= b.length ? b : a
        const pairs = Array.from({ length: Math.max(0, shorter.length - 1) }, (_, index) => shorter.slice(index, index + 2))
        return pairs.length ? pairs.filter(pair => longer.includes(pair)).length / pairs.length : 0
      }
      const experienceStart = (title: string) => messages.findIndex(message =>
        message.role === 'user' && titleScore(message.content.split(/[。；;！!\n]/)[0], title) >= 0.45)
      const organizationToken = (title: string) => title
        .replace(/^(?:某|一家|一段)/, '')
        .replace(/(?:法务部|实习经历|实习|部门|公司)$/g, '')
        .trim()
      const rawBulletsFor = (title: string, nextTitle?: string) => {
        const start = experienceStart(title)
        if (start < 0) return []
        const nextStart = nextTitle ? experienceStart(nextTitle) : -1
        const postExperienceStart = messages.findIndex((message, index) =>
          index > start && message.role === 'assistant' &&
          /为什么.*(?:选择|申请).*(?:方向|专业)|未来.*(?:规划|打算)|毕业后|个人.*特质/.test(message.content))
        const end = nextStart > start ? nextStart : postExperienceStart > start ? postExperienceStart : messages.length
        return messages.slice(start, end)
          .filter(message => message.role === 'user')
          .flatMap(message => message.content.split(/[。！？\n]+/))
          .map(text => text.trim()).filter(text => text.length >= 15)
          .map(text => text.length > 90 ? `${text.slice(0, 90)}…` : text)
      }

      const merged = structuredSections.map((structuredSection, index) => {
        if (!structuredSection.title) return structuredSection
        const canonical = normalizeExperienceTitle(structuredSection.title)
        const detailed = detailedSections.find(section => {
          if (!section.title) return false
          const candidate = normalizeExperienceTitle(section.title)
          return candidate === canonical || candidate.includes(canonical) || canonical.includes(candidate)
        })
        const otherOrganizations = structuredSections
          .filter((_, otherIndex) => otherIndex !== index)
          .map(section => organizationToken(section.title || ''))
          .filter(token => token.length >= 2)
        const candidates = [
          ...(detailed?.bullets || structuredSection.bullets),
          ...rawBulletsFor(structuredSection.title, structuredSections[index + 1]?.title || undefined),
        ].filter(bullet => !otherOrganizations.some(token => bullet.includes(token)))
          .sort((a, b) => b.length - a.length)
        const bullets: string[] = []
        for (const candidate of candidates) {
          const normalized = normalizeExperienceTitle(candidate)
          if (bullets.some(existing => {
            const prior = normalizeExperienceTitle(existing)
            return prior === normalized || prior.includes(normalized) || normalized.includes(prior)
          })) continue
          bullets.push(candidate)
          if (bullets.length >= 5) break
        }
        return { title: structuredSection.title, bullets }
      })
      return serializeSections(merged)
    }

    const allowed = fixedNamesForDimension(dimension)
    if (allowed.length === 0) return ''

    // Older summaries may have put the right experience under the wrong category
    // and may use a longer title. Search every experience-summary pool, but rebuild
    // the result strictly in the CV classification and order.
    const summaryPool = [...MULTI_ENTRY_DIMS, ...MULTI_ENTRY_DIMS]
      .map((key, index) => index < MULTI_ENTRY_DIMS.length
        ? step1Summaries[key]
        : dimensionSummaries[key])
      .filter(Boolean)
      .flatMap(text => parseSections(text))
      .filter(section => section.title)

    const titleScore = (candidate: string, canonical: string) => {
      const a = normalizeExperienceTitle(candidate)
      const b = normalizeExperienceTitle(canonical)
      if (!a || !b) return 0
      if (a === b) return 1
      if (a.includes(b) || b.includes(a)) return 0.95
      const shorter = a.length <= b.length ? a : b
      const longer = a.length <= b.length ? b : a
      const bigrams = Array.from({ length: Math.max(0, shorter.length - 1) }, (_, i) => shorter.slice(i, i + 2))
      if (bigrams.length === 0) return 0
      return bigrams.filter(pair => longer.includes(pair)).length / bigrams.length
    }

    const findExperienceStart = (canonical: string) => messages.findIndex(message => {
      if (message.role !== 'assistant' || !/[？?]/.test(message.content)) return false
      const finalQuestion = message.content.slice(Math.max(message.content.lastIndexOf('。'), message.content.lastIndexOf('！')) + 1)
      if (/目标(?:院校|学校)|申请(?:方向|专业|项目|状态)|什么专业|硕士还是博士|其他学校/.test(finalQuestion)) return false
      if (!/为什么|怎么|如何|什么|哪些|哪一|当时|具体|负责|角色|困难|挑战|解决|结果|收获|反思|选择|决定|测试|设计/.test(finalQuestion)) return false
      return titleScore(message.content, canonical) >= 0.35
    })

    const interviewBullets = (canonical: string) => {
      const start = findExperienceStart(canonical)
      if (start < 0) return []
      const canonicalIndex = cvExperienceEntries.findIndex(entry => entry.name === canonical)
      const nextName = canonicalIndex >= 0 ? cvExperienceEntries[canonicalIndex + 1]?.name : undefined
      const nextStart = nextName ? findExperienceStart(nextName) : -1
      const postExperienceStart = messages.findIndex((message, index) =>
        index > start && message.role === 'assistant' &&
        /为什么.*(?:选择|申请).*(?:方向|专业)|未来.*(?:规划|打算)|毕业后|个人.*特质|最后一个问题/.test(message.content))
      const end = nextStart > start
        ? nextStart
        : postExperienceStart > start ? postExperienceStart : messages.length
      return messages.slice(start, end)
        .filter(message => message.role === 'user')
        .flatMap(message => message.content.split(/[。！？\n]+/))
        .map(text => text.trim())
        .filter(text => text.length >= 15)
        .filter(text => !/^(?:gsa|GSA).{0,20}(?:服务设计|硕士|博士|项目)|目标(?:院校|学校)|申请(?:方向|专业|项目)/i.test(text))
        .map(text => text.length > 90 ? `${text.slice(0, 90)}…` : text)
    }

    const sections = allowed.map(canonical => {
      const matches = summaryPool
        .map(section => ({
          section,
          score: titleScore(section.title || '', canonical),
        }))
        .filter(match => match.score >= 0.35)
        .sort((a, b) =>
          (b.score + Math.min(b.section.bullets.length, 4) * 0.03) -
          (a.score + Math.min(a.section.bullets.length, 4) * 0.03))

      // Merge all matching versions. Prefer concrete, information-rich bullets and
      // remove shorter statements already contained by a more detailed one.
      const candidates = matches
        .flatMap(match => match.section.bullets)
        .map(bullet => bullet.trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .concat(interviewBullets(canonical).sort((a, b) => b.length - a.length))
      const bullets: string[] = []
      for (const candidate of candidates) {
        const normalized = normalizeExperienceTitle(candidate)
        const duplicate = bullets.some(existing => {
          const prior = normalizeExperienceTitle(existing)
          return prior === normalized || prior.includes(normalized) || normalized.includes(prior)
        })
        if (!duplicate) bullets.push(candidate)
        if (bullets.length >= 5) break
      }
      return { title: canonical, bullets }
    })
    return serializeSections(sections)
  }

  useEffect(() => {
    if (messages.length === 0) router.replace('/interview')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dims that need (re)generation: covered, non-empty, and step1Summary absent or cleared.
  // Used as effect dep so the effect re-fires whenever the interview page invalidates a summary.
  const LAST_DIMS = ['motivation', 'plan']
  const pendingDimsKey = confirmationCoveredDimensions
    .filter(d => !emptyDimensions.includes(d) && !step1Summaries[d])
    .filter(d => !LAST_DIMS.includes(d) || interviewComplete)
    .join(',')

  // Older summaries were generated from the academic Q&A window alone and may
  // have lost the school supplied during onboarding. Clear that stale summary
  // once so it is regenerated with quickInfo as an authoritative fact source.
  useEffect(() => {
    const academicSummary = useAppStore.getState().step1Summaries.academic || ''
    if (quickInfo?.school?.trim() && /某(?:高校|大学|院校)/.test(academicSummary)) {
      setStep1Summary('academic', '')
    }
  }, [quickInfo?.school, setStep1Summary])

  // Generate detailed summaries for the confirmation page.
  // Exp dims (project/internship/research) run sequentially so each can pass the
  // prior siblings' summaries as relatedSummaries to prevent cross-dim duplication.
  // Re-runs whenever pendingDimsKey changes (new dims covered, or summaries invalidated).
  useEffect(() => {
    if (messages.length === 0 || !pendingDimsKey) return

    const EXP_DIMS = ['research', 'internship', 'project']

    async function fetchSummary(dim: string, relatedSummaries: Record<string, string> = {}) {
      // Always read fresh state — Zustand persist rehydrates asynchronously.
      if (useAppStore.getState().step1Summaries[dim]) return
      setParagraphLoading(prev => ({ ...prev, [dim]: true }))
      try {
        const structuredSummary = useAppStore.getState().dimensionSummaries[dim] || ''
        const res = await fetch('/api/summarize-dimension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dimension: dim,
            messages,
            relatedSummaries,
            format: 'paragraph',
            structuredSummary,
            quickInfo: useAppStore.getState().quickInfo,
          }),
        })
        const data = await res.json()
        if (data.summary && !useAppStore.getState().step1Summaries[dim]) {
          setStep1Summary(dim, data.summary)
        }
      } catch {
        // silently ignore; card stays blank
      } finally {
        setParagraphLoading(prev => ({ ...prev, [dim]: false }))
      }
    }

    async function generateAll() {
      const dims = pendingDimsKey.split(',').filter(Boolean)
      if (dims.length === 0) return

      const exp       = EXP_DIMS.filter(d => dims.includes(d))
      const early     = dims.filter(d => !EXP_DIMS.includes(d) && !LAST_DIMS.includes(d))
      const last      = LAST_DIMS.filter(d => dims.includes(d))

      // 1. academic 等早期维度并行生成
      await Promise.all(early.map(d => fetchSummary(d)))

      // 2. 经历维度顺序生成（需要 relatedSummaries 去重）
      for (const dim of exp) {
        const relatedSummaries: Record<string, string> = {}
        for (const other of EXP_DIMS) {
          if (other !== dim) {
            const s = useAppStore.getState().step1Summaries[other]
            if (s) relatedSummaries[other] = s
          }
        }
        await fetchSummary(dim, relatedSummaries)
      }

      // 3. 最后生成申请动机和未来规划
      for (const dim of last) {
        await fetchSummary(dim)
      }
    }

    generateAll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDimsKey])

  async function generatePersonas(regenerate = false) {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summaries: step1Summaries,
          existingPersonas: regenerate ? personas : [],
        }),
      })
      const data = await res.json()
      if (data.personas) { setPersonas(data.personas); setSelectedPersona(data.personas[0]); setStep(2) }
      else setError('生成失败，请重试')
    } catch { setError('网络错误，请检查连接后重试') }
    finally { setLoading(false) }
  }

  function handleGoToPersona() {
    if (personas.length > 0) { setStep(2); return }
    generatePersonas()
  }

  // When the user edits any experience summary, invalidate personas so they
  // are regenerated the next time the user clicks "生成叙事方向".
  function saveAndInvalidate(key: string, val: string) {
    setStep1Summary(key, val)
    if (personas.length > 0) {
      setPersonas([])
      setSelectedPersona(null)
    }
  }

  function handleContinue() {
    if (!selectedPersona) return
    router.push('/framework')
  }

  // ── Step 1 ──────────────────────────────────────────────────────────────────
  // A dim is "effectively empty" if flagged as empty OR if the generated summary is just "无"
  function dimHasContent(key: string): boolean {
    if (emptyDimensions.includes(key)) return false
    if (cvText && MULTI_ENTRY_DIMS.includes(key) && fixedNamesForDimension(key).length === 0) return false
    const s = summaryForDimension(key)
    if (s && /^[·•\s]*无[。.]?\s*$/.test(s.trim())) return false
    return true
  }

  if (step === 1) {
    return (
      <div className="min-h-screen bg-[#FAF9F6]">
        <Nav step={1} onGoStep1={() => {}} onGoStep2={personas.length > 0 ? () => setStep(2) : undefined} />

        <main className="max-w-3xl mx-auto px-8 py-12">
          {/* Header */}
          <div className="mb-10">
            <h1 className="text-xl font-semibold text-stone-900 mb-2">Omi 对你的了解</h1>
            <p className="text-sm text-stone-400">在选择叙事方向前，先确认 Omi 是否准确理解了你的经历。如有偏差，可点击「编辑」修改。</p>
          </div>

          {/* academic — full width, single entry */}
          {confirmationCoveredDimensions.includes('academic') && dimHasContent('academic') && (() => {
            const dim = INTERVIEW_DIMENSIONS.find(d => d.key === 'academic')!
            return (
              <div className="mb-3">
                <ExperienceCard
                  dimKey="academic" label={dim.label}
                  summary={paragraphLoading['academic'] ? '' : (step1Summaries['academic'] || '')}
                  isCovered={true}
                  onSave={val => saveAndInvalidate('academic', val)}
                />
              </div>
            )
          })()}

          {/* Experience sections — fixed order: research → internship → project */}
          {CONFIRM_EXP_ORDER.map(key => {
            if (!confirmationCoveredDimensions.includes(key) || !dimHasContent(key)) return null
            const dim = INTERVIEW_DIMENSIONS.find(d => d.key === key)!
            return (
              <div key={key} className="mb-3">
                <MultiEntryCard
                  dimKey={key} label={dim.label}
                  summary={summaryForDimension(key)}
                  loading={!!paragraphLoading[key]}
                  onSave={val => saveAndInvalidate(key, val)}
                />
              </div>
            )
          })}

          {/* paired row: motivation + plan */}
          {PAIRED_ROWS.map(([a, b]) => {
            const keys = [a, b].filter(k => confirmationCoveredDimensions.includes(k) && dimHasContent(k))
            if (keys.length === 0) return null
            return (
              <div key={`${a}-${b}`} className="grid grid-cols-1 gap-3 mb-3">
                {keys.map(key => {
                  const dim = INTERVIEW_DIMENSIONS.find(d => d.key === key)!
                  const isLoading = !!paragraphLoading[key]
                  if (MULTI_ENTRY_DIMS.includes(key)) {
                    return (
                      <MultiEntryCard
                        key={key} dimKey={key} label={dim.label}
                        summary={summaryForDimension(key)}
                        loading={isLoading}
                        onSave={val => saveAndInvalidate(key, val)}
                      />
                    )
                  }
                  return (
                    <ExperienceCard
                      key={key} dimKey={key} label={dim.label}
                      summary={isLoading ? '' : (step1Summaries[key] || '')}
                      isCovered={true}
                      onSave={val => setStep1Summary(key, val)}
                    />
                  )
                })}
              </div>
            )
          })}

          {/* CTA */}
          <div className="border-t border-stone-200 pt-8 mt-6">
            <div className="flex items-center justify-between">
              <Link href="/interview" className="text-sm text-stone-400 hover:text-stone-600 transition-colors">
                ← 返回访谈
              </Link>
              <button
                onClick={handleGoToPersona}
                disabled={loading}
                className="bg-stone-900 hover:bg-stone-800 disabled:opacity-50 text-white font-medium px-7 py-3 rounded-xl text-sm transition-colors flex items-center gap-2"
              >
                {loading ? (
                  <><span className="w-3.5 h-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />生成中…</>
                ) : '确认无误，生成叙事方向 →'}
              </button>
            </div>
            {error && <p className="text-red-500 text-xs mt-3 text-right">{error}</p>}
          </div>
        </main>
      </div>
    )
  }

  // ── Step 2: Persona Selection ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#FAF9F6]">
      <Nav step={2} onGoStep1={() => setStep(1)} />

      <main className="max-w-4xl mx-auto px-8 py-12">
        <div className="mb-10">
          <h1 className="text-xl font-semibold text-stone-900 mb-2">选择你的叙事方向</h1>
          <p className="text-sm text-stone-400">
            AI 基于你的经历设计了 {personas.length} 种叙事视角，选择一个最符合你感觉的方向——文书框架将围绕它展开。
          </p>
        </div>

        <div className="space-y-3 mb-8">
          {personas.map((p, i) => (
            <PersonaCard
              key={p.id} persona={p}
              color={PERSONA_COLORS[i % PERSONA_COLORS.length]}
              selected={selectedPersona?.id === p.id}
              onSelect={() => { setSelectedPersona(p); setFramework([]) }}
            />
          ))}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => generatePersonas(true)} className="text-sm text-stone-400 hover:text-stone-600 transition-colors">
              重新生成
            </button>
            <button onClick={() => setStep(1)} className="text-sm text-stone-400 hover:text-stone-600 transition-colors">
              ← 返回经历
            </button>
          </div>
          <button
            onClick={handleContinue}
            disabled={!selectedPersona}
            className="bg-stone-900 hover:bg-stone-800 disabled:opacity-40 text-white font-medium px-7 py-3 rounded-xl text-sm transition-colors"
          >
            用这个方向，生成框架 →
          </button>
        </div>
      </main>
    </div>
  )
}
