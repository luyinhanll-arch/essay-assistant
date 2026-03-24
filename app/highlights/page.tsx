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

/** Extract first meaningful bullet from a dimension summary string */
function firstBullet(summary: string): string {
  if (!summary) return ''
  const lines = summary.split('\n').map(l => l.trim()).filter(Boolean)
  // Skip section titles (start with #)
  const bullet = lines.find(l => !l.startsWith('#'))
  return bullet ? bullet.replace(/^[·•]\s*/, '') : ''
}

function PersonaCard({ persona, color, selected, onSelect, onUpdate, step1Summaries }: {
  persona: Persona; color: Color; selected: boolean; onSelect: () => void
  onUpdate?: (updated: Persona) => void
  step1Summaries?: Record<string, string>
}) {
  const c = COLOR_STYLES[color]
  const [lines, setLines] = useState<string[]>(() =>
    persona.evidence.split('\n').map(l => l.replace(/^·\s*/, '').trim()).filter(Boolean)
  )
  const [addingCustom, setAddingCustom] = useState(false)
  const [customText, setCustomText] = useState('')

  // Direction editing state
  const [editingDirection, setEditingDirection] = useState(false)
  const [draftTitle, setDraftTitle]       = useState(persona.title)
  const [draftTagline, setDraftTagline]   = useState(persona.tagline)
  const [draftDesc, setDraftDesc]         = useState(persona.description)
  const [draftFocus, setDraftFocus]       = useState(persona.focus)

  useEffect(() => {
    setLines(persona.evidence.split('\n').map(l => l.replace(/^·\s*/, '').trim()).filter(Boolean))
    setDraftTitle(persona.title)
    setDraftTagline(persona.tagline)
    setDraftDesc(persona.description)
    setDraftFocus(persona.focus)
  }, [persona.evidence, persona.title, persona.tagline, persona.description, persona.focus])

  function commitEvidence(newLines: string[]) {
    setLines(newLines)
    onUpdate?.({ ...persona, evidence: newLines.map(l => `· ${l}`).join('\n') })
  }

  function removeLine(i: number) { commitEvidence(lines.filter((_, idx) => idx !== i)) }

  function addCustom() {
    const t = customText.trim()
    if (t) { commitEvidence([...lines, t]); setCustomText('') }
    setAddingCustom(false)
  }

  function addFromDim(dimKey: string, dimLabel: string) {
    const summary = step1Summaries?.[dimKey] ?? ''
    const bullet = firstBullet(summary) || dimLabel
    if (!lines.includes(bullet)) commitEvidence([...lines, bullet])
  }

  function saveDirection() {
    onUpdate?.({
      ...persona,
      title:       draftTitle.trim() || persona.title,
      tagline:     draftTagline.trim() || persona.tagline,
      description: draftDesc.trim() || persona.description,
      focus:       draftFocus.trim() || persona.focus,
    })
    setEditingDirection(false)
  }

  function cancelDirection() {
    setDraftTitle(persona.title)
    setDraftTagline(persona.tagline)
    setDraftDesc(persona.description)
    setDraftFocus(persona.focus)
    setEditingDirection(false)
  }

  const availableDims = INTERVIEW_DIMENSIONS.filter(d =>
    step1Summaries?.[d.key] && !lines.some(l => l.startsWith(d.label))
  )

  return (
    <div
      onClick={!selected ? onSelect : undefined}
      className={`rounded-xl border p-5 transition-all ${
        selected ? `${c.border} ${c.bg}` : 'border-stone-200 bg-white hover:border-stone-300 cursor-pointer'
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
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
        {selected && !editingDirection && (
          <button
            onClick={e => { e.stopPropagation(); setEditingDirection(true) }}
            className="shrink-0 text-[11px] text-stone-400 hover:text-stone-700 transition-colors"
          >
            编辑方向
          </button>
        )}
      </div>

      {/* Direction edit form */}
      {editingDirection ? (
        <div className="mb-4 space-y-2" onClick={e => e.stopPropagation()}>
          <div>
            <label className="text-[10px] text-stone-400 font-medium block mb-1">人设标签</label>
            <input
              value={draftTitle}
              onChange={e => setDraftTitle(e.target.value)}
              placeholder={'4-8字，如"工程实践派"'}
              className="w-full text-xs text-stone-800 font-semibold bg-white border border-stone-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-stone-400"
            />
          </div>
          <div>
            <label className="text-[10px] text-stone-400 font-medium block mb-1">核心定位</label>
            <input
              value={draftTagline}
              onChange={e => setDraftTagline(e.target.value)}
              placeholder="一句话说明叙事逻辑"
              className="w-full text-xs text-stone-700 bg-white border border-stone-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-stone-400"
            />
          </div>
          <div>
            <label className="text-[10px] text-stone-400 font-medium block mb-1">方向描述</label>
            <textarea
              value={draftDesc}
              onChange={e => setDraftDesc(e.target.value)}
              rows={3}
              className="w-full text-xs text-stone-700 bg-white border border-stone-200 rounded-xl px-2.5 py-2 resize-none focus:outline-none focus:border-stone-400 leading-relaxed"
            />
          </div>
          <div>
            <label className="text-[10px] text-stone-400 font-medium block mb-1">文书侧重</label>
            <input
              value={draftFocus}
              onChange={e => setDraftFocus(e.target.value)}
              placeholder="文书应重点展示什么"
              className="w-full text-xs text-stone-700 bg-white border border-stone-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-stone-400"
            />
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <button onClick={cancelDirection} className="text-xs text-stone-400 hover:text-stone-600 px-3 py-1.5">取消</button>
            <button onClick={saveDirection} className="text-xs font-medium text-white bg-stone-900 hover:bg-stone-800 px-3 py-1.5 rounded-lg transition-colors">保存</button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-stone-600 leading-relaxed mb-4">{persona.description}</p>
      )}

      {/* Evidence section */}
      <div className={`rounded-xl p-3 mb-3 ${selected ? 'bg-white/60' : 'bg-stone-50'}`}>
        <p className="text-[10px] text-stone-400 font-medium mb-1.5">支撑你的经历</p>
        <ul className="space-y-1">
          {lines.map((line, i) => (
            <li key={i} className="group flex items-start gap-1.5 text-xs text-stone-500 leading-relaxed">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${selected ? c.dot : 'bg-stone-300'}`} />
              <span className="flex-1">{line}</span>
              {selected && (
                <button
                  onClick={e => { e.stopPropagation(); removeLine(i) }}
                  className="opacity-0 group-hover:opacity-100 shrink-0 text-stone-300 hover:text-red-400 transition-all text-[11px] leading-none mt-0.5"
                >×</button>
              )}
            </li>
          ))}
        </ul>

        {/* Add controls — only when selected */}
        {selected && (
          <div className="mt-2.5 space-y-2">
            {/* Dim chips */}
            {availableDims.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {availableDims.map(d => (
                  <button
                    key={d.key}
                    onClick={e => { e.stopPropagation(); addFromDim(d.key, d.label) }}
                    className="text-[11px] text-stone-500 bg-white border border-stone-200 hover:border-stone-400 hover:text-stone-800 rounded-full px-2.5 py-0.5 transition-colors"
                  >
                    + {d.label}
                  </button>
                ))}
              </div>
            )}

            {/* Custom input */}
            {addingCustom ? (
              <div className="flex gap-1.5" onClick={e => e.stopPropagation()}>
                <input
                  autoFocus
                  value={customText}
                  onChange={e => setCustomText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addCustom(); if (e.key === 'Escape') setAddingCustom(false) }}
                  placeholder="输入一条经历描述…"
                  className="flex-1 text-xs text-stone-700 bg-white border border-stone-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-stone-500"
                />
                <button onClick={addCustom} className="text-[11px] font-medium text-white bg-stone-900 hover:bg-stone-700 rounded-lg px-2.5 py-1.5 transition-colors">确认</button>
                <button onClick={() => setAddingCustom(false)} className="text-[11px] text-stone-400 hover:text-stone-600 px-1.5">取消</button>
              </div>
            ) : (
              <button
                onClick={e => { e.stopPropagation(); setAddingCustom(true) }}
                className="text-[11px] text-stone-400 hover:text-stone-600 transition-colors"
              >
                + 自定义添加
              </button>
            )}
          </div>
        )}
      </div>

      {!editingDirection && (
        <div className={`text-xs rounded-lg px-3 py-2 ${selected ? c.tag : 'bg-stone-50 text-stone-400'}`}>
          <span className="font-medium">文书侧重：</span>{persona.focus}
        </div>
      )}
    </div>
  )
}

// ─── Experience card ──────────────────────────────────────────────────────────

const DIM_ICONS: Record<string, string> = {
  academic: '🎓', project: '💻', internship: '🏢',
  research: '🔬', motivation: '🎯', plan: '🗺️', personal: '✨',
}

// Rendered as pairs (side-by-side when both present)
const PAIRED_ROWS = [['internship', 'research'], ['motivation', 'plan']]
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
    emptyDimensions, coveredDimensions,
    step1Summaries, setStep1Summary,
    setPersonas, setSelectedPersona,
  } = useAppStore()

  const [step, setStep]       = useState<1 | 2>(personas.length > 0 ? 2 : 1)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState('')

  const [paragraphLoading, setParagraphLoading] = useState<Record<string, boolean>>({})

  useEffect(() => {
    if (messages.length === 0) router.replace('/interview')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dims that need (re)generation: covered, non-empty, and step1Summary absent or cleared.
  // Used as effect dep so the effect re-fires whenever the interview page invalidates a summary.
  const pendingDimsKey = coveredDimensions
    .filter(d => !emptyDimensions.includes(d) && !step1Summaries[d])
    .join(',')

  // Generate detailed summaries for the confirmation page.
  // Exp dims (project/internship/research) run sequentially so each can pass the
  // prior siblings' summaries as relatedSummaries to prevent cross-dim duplication.
  // Re-runs whenever pendingDimsKey changes (new dims covered, or summaries invalidated).
  useEffect(() => {
    if (messages.length === 0 || !pendingDimsKey) return

    const EXP_DIMS = ['project', 'internship', 'research']

    async function fetchSummary(dim: string, relatedSummaries: Record<string, string> = {}) {
      // Always read fresh state — Zustand persist rehydrates asynchronously.
      if (useAppStore.getState().step1Summaries[dim]) return
      setParagraphLoading(prev => ({ ...prev, [dim]: true }))
      try {
        const res = await fetch('/api/summarize-dimension', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dimension: dim, messages, relatedSummaries, format: 'paragraph' }),
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

      const nonExp = dims.filter(d => !EXP_DIMS.includes(d))
      const exp    = EXP_DIMS.filter(d => dims.includes(d))

      await Promise.all(nonExp.map(d => fetchSummary(d)))

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
    }

    generateAll()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDimsKey])

  async function generatePersonas() {
    setLoading(true); setError('')
    const transcript = messages
      .map(m => `${m.role === 'user' ? '申请者' : 'AI顾问'}: ${m.content}`)
      .join('\n\n')
    try {
      const res = await fetch('/api/highlights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript }),
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
    const s = step1Summaries[key]
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
          {coveredDimensions.includes('academic') && dimHasContent('academic') && (() => {
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

          {/* project — full width, multi entry */}
          {coveredDimensions.includes('project') && dimHasContent('project') && (() => {
            const dim = INTERVIEW_DIMENSIONS.find(d => d.key === 'project')!
            return (
              <div className="mb-3">
                <MultiEntryCard
                  dimKey="project" label={dim.label}
                  summary={step1Summaries['project'] || ''}
                  loading={!!paragraphLoading['project']}
                  onSave={val => saveAndInvalidate('project', val)}
                />
              </div>
            )
          })()}

          {/* paired rows: internship+research (multi), motivation+plan (single) */}
          {PAIRED_ROWS.map(([a, b]) => {
            const keys = [a, b].filter(k => coveredDimensions.includes(k) && dimHasContent(k))
            if (keys.length === 0) return null
            return (
              <div key={`${a}-${b}`} className={`grid gap-3 mb-3 ${keys.length === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {keys.map(key => {
                  const dim = INTERVIEW_DIMENSIONS.find(d => d.key === key)!
                  const isLoading = !!paragraphLoading[key]
                  if (MULTI_ENTRY_DIMS.includes(key)) {
                    return (
                      <MultiEntryCard
                        key={key} dimKey={key} label={dim.label}
                        summary={step1Summaries[key] || ''}
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

          {/* personal — full width */}
          {coveredDimensions.includes('personal') && dimHasContent('personal') && (() => {
            const dim = INTERVIEW_DIMENSIONS.find(d => d.key === 'personal')!
            return (
              <div className="mb-3">
                <ExperienceCard
                  dimKey="personal" label={dim.label}
                  summary={paragraphLoading['personal'] ? '' : (step1Summaries['personal'] || '')}
                  isCovered={coveredDimensions.includes('personal')}
                  onSave={val => saveAndInvalidate('personal', val)}
                />
              </div>
            )
          })()}

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
              onSelect={() => setSelectedPersona(p)}
              onUpdate={updated => setSelectedPersona(updated)}
              step1Summaries={step1Summaries}
            />
          ))}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => generatePersonas()} className="text-sm text-stone-400 hover:text-stone-600 transition-colors">
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
