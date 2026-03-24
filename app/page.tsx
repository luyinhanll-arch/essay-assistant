import Link from 'next/link'

const features = [
  {
    title: '针对你的目标院校定制侧重',
    desc: '可粘贴学校官网链接自动提取申请要求，框架侧重随之调整；也可手动填写字数限制与院校偏好。',
  },
  {
    title: '听得出你平庸文字背后的闪光点',
    desc: '通过 7 个维度的深度访谈，Omi 主动追问细节，将你的经历整理成清晰的叙事方向——包括那些你自己都忽略的亮点。',
  },
  {
    title: '从框架到初稿，全程有据可依',
    desc: 'SOP 和 PS 分别生成不同框架与写作策略；中英对照阅读，随时用自然语言指令修改，支持导出 TXT / DOC。',
  },
]

const steps = [
  { num: '01', title: '深度访谈', desc: 'Omi 覆盖 7 个维度主动追问，挖掘学术、项目、实习、科研、动机等真实经历' },
  { num: '02', title: '人设定位', desc: 'AI 整理经历摘要，提炼 2–3 个叙事方向，选一个最符合你感觉的' },
  { num: '03', title: '文书框架', desc: '支持 SOP / PS，生成专属框架，可调整顺序与核心论点' },
  { num: '04', title: '初稿 & 修改', desc: '生成完整英文初稿，中英对照阅读，输入修改指令迭代打磨' },
]

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#FAF9F6] text-stone-900">

      {/* ── Nav ── */}
      <nav className="border-b border-stone-200 px-8 py-4 flex items-center justify-between">
        <span className="font-bold text-orange-500 tracking-tight">EssayMind</span>
        <Link href="/interview" className="text-sm text-stone-500 hover:text-stone-900 transition-colors">
          开始写文书 →
        </Link>
      </nav>

      {/* ── Hero ── */}
      <section className="max-w-3xl mx-auto px-8 pt-24 pb-28 text-center">
        <p className="text-xs text-stone-400 tracking-widest uppercase mb-10">
          AI 驱动 · 专为研究生申请者设计
        </p>
        <h1 className="text-[2.75rem] font-semibold leading-[1.2] tracking-tight text-stone-900 mb-7">
          你的留学文书，<br />
          <span className="text-stone-500">应该是你真实的故事</span>
        </h1>
        <p className="text-base text-stone-500 leading-relaxed mb-12 max-w-xl mx-auto">
          它<strong className="text-stone-800 font-medium">听得出</strong>你平庸文字背后的真实闪光点，
          它<strong className="text-stone-800 font-medium">帮你找到</strong>一个属于自己的叙事角度。
          不依赖中介，不靠 AI 模板——访谈、定位、框架、初稿，一步一步写出真正属于你的文书。
        </p>
        <Link
          href="/interview"
          className="inline-flex items-center gap-2 bg-stone-900 hover:bg-stone-800 text-white font-medium px-8 py-3.5 rounded-xl text-base transition-colors"
        >
          免费开始写文书 →
        </Link>
      </section>

      {/* ── Steps ── */}
      <section className="border-t border-stone-200">
        <div className="max-w-5xl mx-auto px-8 py-16">
          <p className="text-xs text-stone-400 tracking-widest uppercase mb-12">如何运作</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-0">
            {steps.map((step, i) => (
              <div key={i} className={`pr-8 ${i > 0 ? 'pl-8 border-l border-stone-200' : ''}`}>
                <p className="text-sm font-medium text-stone-300 mb-4 tabular-nums">{step.num}</p>
                <p className="font-medium text-stone-900 mb-1.5">{step.title}</p>
                <p className="text-sm text-stone-400 leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="border-t border-stone-200">
        <div className="max-w-5xl mx-auto px-8 py-16">
          <p className="text-xs text-stone-400 tracking-widest uppercase mb-12">为什么不用 ChatGPT 就够了</p>
          <div className="divide-y divide-stone-200">
            {features.map((f, i) => (
              <div key={i} className="flex items-start gap-12 py-6">
                <span className="text-sm text-stone-300 tabular-nums shrink-0 w-6 pt-0.5">0{i + 1}</span>
                <p className="font-medium text-stone-900 w-64 shrink-0 leading-snug">{f.title}</p>
                <p className="text-sm text-stone-500 leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA bottom ── */}
      <section className="border-t border-stone-200">
        <div className="max-w-3xl mx-auto px-8 py-24 text-center">
          <h2 className="text-2xl font-semibold text-stone-900 mb-4">
            准备好发现真实的自己了吗？
          </h2>
          <p className="text-stone-500 mb-10 text-sm leading-relaxed">
            每一个有真实追求的申请者，都值得用自己的故事打动招生官。
          </p>
          <Link
            href="/interview"
            className="inline-flex items-center gap-2 bg-stone-900 hover:bg-stone-800 text-white font-medium px-8 py-3.5 rounded-xl text-base transition-colors"
          >
            立即开始 →
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-stone-200 py-6 text-center text-xs text-stone-400 tracking-wide">
        EssayMind · AI 留学文书助手 · MVP 版本
      </footer>

    </main>
  )
}
