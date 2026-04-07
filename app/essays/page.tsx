'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { getUserToken, type Essay } from '@/lib/supabase'

export default function EssaysPage() {
  const [essays, setEssays] = useState<Essay[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    const token = getUserToken()
    fetch(`/api/essays?token=${token}`)
      .then(r => r.json())
      .then(d => setEssays(d.essays ?? []))
      .finally(() => setLoading(false))
  }, [])

  async function handleDelete(id: string) {
    if (!confirm('确定删除这篇文书？')) return
    setDeleting(id)
    const token = getUserToken()
    await fetch(`/api/essays?token=${token}&id=${id}`, { method: 'DELETE' })
    setEssays(prev => prev.filter(e => e.id !== id))
    setDeleting(null)
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString('zh-CN', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-[#FAF9F6] px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-orange-400 font-bold tracking-tight">EssayMind</Link>
          <span className="text-stone-400 text-sm">我的文书</span>
        </div>
        <Link href="/editor" className="text-sm px-4 py-2 rounded-lg bg-orange-400 hover:bg-orange-500 text-white transition-colors">
          去编辑器
        </Link>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-10">
        <h1 className="text-2xl font-semibold mb-6">我的文书</h1>

        {loading && (
          <div className="text-stone-400 text-sm">加载中…</div>
        )}

        {!loading && essays.length === 0 && (
          <div className="text-center py-20 text-stone-400">
            <p className="text-lg mb-2">还没有保存的文书</p>
            <p className="text-sm">在编辑器页面点击「保存文书」即可保存</p>
          </div>
        )}

        <div className="space-y-4">
          {essays.map(essay => (
            <div key={essay.id} className="bg-white border border-stone-200 rounded-2xl overflow-hidden">
              {/* Card header */}
              <div className="px-6 py-4 flex items-start justify-between">
                <div>
                  <div className="font-semibold text-lg">{essay.school}</div>
                  {(essay.program || essay.degree) && (
                    <div className="text-sm text-stone-500 mt-0.5">
                      {[essay.program, essay.degree].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  <div className="text-xs text-stone-400 mt-1">更新于 {formatDate(essay.updated_at)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-4">
                  <button
                    onClick={() => setExpandedId(expandedId === essay.id ? null : essay.id)}
                    className="text-sm px-3 py-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 transition-colors"
                  >
                    {expandedId === essay.id ? '收起' : '查看'}
                  </button>
                  <button
                    onClick={() => handleDelete(essay.id)}
                    disabled={deleting === essay.id}
                    className="text-sm px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-500 transition-colors disabled:opacity-40"
                  >
                    {deleting === essay.id ? '删除中…' : '删除'}
                  </button>
                </div>
              </div>

              {/* Expanded content */}
              {expandedId === essay.id && (
                <div className="border-t border-stone-100">
                  {essay.en_text && (
                    <div className="px-6 py-4">
                      <div className="text-xs font-medium text-stone-400 mb-2 uppercase tracking-wide">英文</div>
                      <pre className="text-sm text-stone-800 whitespace-pre-wrap font-sans leading-relaxed">
                        {essay.en_text}
                      </pre>
                    </div>
                  )}
                  {essay.zh_text && (
                    <div className="px-6 py-4 border-t border-stone-100 bg-stone-50">
                      <div className="text-xs font-medium text-stone-400 mb-2 uppercase tracking-wide">中文翻译</div>
                      <pre className="text-sm text-stone-700 whitespace-pre-wrap font-sans leading-relaxed">
                        {essay.zh_text}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
