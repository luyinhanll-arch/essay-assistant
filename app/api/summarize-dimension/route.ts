import { callDeepSeek } from '@/lib/deepseek'
import type { Message } from '@/lib/types'

const DIMENSION_LABELS: Record<string, string> = {
  academic: '学术背景',
  research: '科研经历',
  internship: '实习经历',
  project: '项目经历',
  motivation: '申请动机',
  plan: '未来规划',
  personal: '个人特质'
}

// 段落格式：面向申请者的自然语言叙述，用于高亮页 Step 1 展示
const PARAGRAPH_FOCUS: Record<string, string> = {
  academic:   '就读学校与专业、最有收获的课程或研究方向、毕设/论文主题、学术成绩表现',
  research:   '研究机构/导师、课题方向、做了哪些具体工作、取得的成果或发现',
  internship: '实习公司与岗位、负责的核心项目或任务、遇到的挑战与解决方式、可量化成果',
  project:    '项目/活动名称与目的、采用的方法或思路（不限技术类）、遇到的难题与解决方式、最终结果或影响',
  motivation: '申请这个方向的具体触发点（哪件事/哪个时刻让你决定的）、为什么选择这个专业/学校、出国读书的深层动机',
  plan:       '毕业后的目标方向或职位、短期计划（1-2年）、长期愿景',
  personal:   '用户自我认可的核心特质（具体是什么特质）、支撑该特质的印象深刻经历或挑战、这段经历对用户的影响或改变',
}

/**
 * Determine which messages to use for summarising a dimension.
 *
 * Multi-entry dimensions (project / internship / research):
 *   Use the FULL conversation so that experiences mentioned in passing during
 *   other sections are not missed.  The per-dimension exclusion rules in the
 *   prompt prevent cross-contamination.
 *
 * Single-entry dimensions (academic / motivation / plan / personal):
 *   Slice to the dedicated Q&A window to avoid polluting the summary with
 *   unrelated content from elsewhere in the conversation.
 *
 *   Special cases for single-entry:
 *   - motivation + DEFERRED: extend the window to include the retrospective
 *     revisit just before [ASKING:personal].
 *   - personal: drop the opening AI trait-summary message so only the user's
 *     own words are summarised.
 */
function extractDimWindow(messages: Message[], dim: string): Message[] {
  // Multi-entry dims: always use full conversation
  if (['project', 'internship', 'research'].includes(dim)) {
    return messages
  }

  // Tags are stripped from .content; check .rawContent first
  const src = (m: Message): string => m.rawContent ?? m.content

  const askRe = new RegExp(`\\[ASKING[：:]\\s*${dim}\\]`, 'i')
  let start = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && askRe.test(src(messages[i]))) {
      start = i; break
    }
  }
  if (start === -1) return messages

  // ── motivation: if deferred, extend window to include the revisit ──────────
  if (dim === 'motivation') {
    const tail = messages.slice(start)
    const wasDeferred = tail.some(
      m => m.role === 'assistant' && /\[DEFERRED[：:]\s*motivation\]/i.test(src(m))
    )
    if (wasDeferred) {
      let end = messages.length
      for (let i = start + 1; i < messages.length; i++) {
        if (messages[i].role === 'assistant' &&
            /\[ASKING[：:]\s*personal\]/i.test(src(messages[i]))) {
          end = i; break
        }
      }
      return messages.slice(start, end)
    }
  }

  // ── personal: drop the opening AI message (it's a summary of earlier dims) ─
  if (dim === 'personal') {
    const sliced = messages.slice(start)
    const firstUserIdx = sliced.findIndex(m => m.role === 'user')
    if (firstUserIdx !== -1) return sliced.slice(firstUserIdx)
    return sliced
  }

  let end = messages.length
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      const m = src(messages[i]).match(/\[ASKING[：:]\s*([^\]]+)\]/i)
      if (m && m[1].trim() !== dim) { end = i; break }
    }
  }
  return messages.slice(start, end)
}

export async function POST(req: Request) {
  try {
    const {
      dimension,
      messages: rawMessages,
      format = 'structured',
      relatedSummaries = {},
      cvText = '',
      cvAnalysis = '',
    }: { dimension: string; messages: Message[]; format?: 'structured' | 'paragraph'; relatedSummaries?: Record<string, string>; cvText?: string; cvAnalysis?: string } = await req.json()

    if (!dimension || !rawMessages || !Array.isArray(rawMessages)) {
      return Response.json({ error: '缺少必要参数' }, { status: 400 })
    }

    // Use only the relevant Q&A window so the AI doesn't confuse content across dimensions
    const messages = extractDimWindow(rawMessages, dimension)

    const dimensionLabel = DIMENSION_LABELS[dimension] || dimension
    const conversationText = messages
      .map(m => `${m.role === 'user' ? '用户' : '助理'}: ${m.content}`)
      .join('\n')

    // CV context block — injected into prompts for CV users
    const hasCv = !!(cvText?.trim())
    const cvBlock = hasCv ? `\n\n【申请者简历原文】\n${cvText.trim()}` : ''
    const cvAnalysisBlock = hasCv && cvAnalysis?.trim()
      ? `\n\n【AI对简历的深挖分析】\n${cvAnalysis.trim()}`
      : ''

    // Extract experience names from cvAnalysis for use as canonical section titles
    const cvEntryNames: string[] = []
    if (hasCv && cvAnalysis?.trim()) {
      for (const line of cvAnalysis.split('\n')) {
        const m = line.trim().match(/^经历名称[：:](.+)/)
        if (m) cvEntryNames.push(m[1].trim())
      }
    }
    const cvNamesBlock = cvEntryNames.length > 0
      ? `\n\n【重要】以下是申请者在简历分析中标注的经历名称。当对话中提到的经历与下列名称匹配时，**必须直接使用下列名称**作为 # 标题，不得自创新标题：\n${cvEntryNames.map(n => `- ${n}`).join('\n')}`
      : ''

    let systemPrompt: string
    let userPrompt: string

    // 各维度的排除规则（防止跨维度内容混入）
    const DIM_EXCLUDE: Record<string, string> = {
      academic:   '**不要**包含任何项目经历（课程项目、个人项目、竞赛、毕业设计等）——这些有独立维度；只包含学校、专业、课程学习、学术成绩相关内容',
      motivation: '**不要**包含对具体项目或经历的描述——这些有独立维度；只包含申请动机本身（为什么选这个专业/学校/国家，触发申请的契机）',
      project:    '**包含**：课程作业/课程大作业/课程项目、个人项目、竞赛/比赛、学生组织活动。**不要**包含：实习（公司/机构的实习岗位）、在导师/实验室明确指导下的正式科研课题、**学术论文/研究报告**（有研究性写作和发表的内容归科研经历）',
      internship: '**不要**包含课程项目、个人项目、竞赛等非实习内容，也不要包含科研课题或学术论文',
      research:   '**包含**：在导师/实验室框架下的正式科研课题、**独立撰写并发表的学术论文/研究报告**（即使是基于实习或自主研究的成果，只要有学术研究性质且正式发表，均归入本维度）。**不要**包含：课程作业/课程项目（无发表）、竞赛、社团活动、实习岗位本身',
    }
    const excludeRule = DIM_EXCLUDE[dimension] ? `- ${DIM_EXCLUDE[dimension]}\n` : ''

    // 已被其他经历维度认领的经历——只提取经历名称，明确禁止重复
    const RELATED_LABELS: Record<string, string> = { project: '项目经历', internship: '实习经历', research: '科研经历' }
    const claimedLines = Object.entries(relatedSummaries)
      .filter(([, s]) => s)
      .flatMap(([dim, summary]) => {
        const names = summary.split('\n')
          .filter(l => l.startsWith('# '))
          .map(l => l.slice(2).trim())
          .filter(Boolean)
        return names.map(n => `- 「${n}」（已归入「${RELATED_LABELS[dim] || dim}」）`)
      })
    const claimedBlock = claimedLines.length > 0
      ? `【系统硬规定——不可违反】以下经历已被分配给其他维度，无论你认为它与本维度有多相关，都**绝对不能**出现在本维度的输出中。如果你唯一能想到的经历就是下面这些，请输出空白或"无"：\n${claimedLines.join('\n')}`
      : ''

    if (format === 'paragraph') {
      const isMultiEntry = ['project', 'internship', 'research'].includes(dimension)
      systemPrompt = `你是一位资深留学文书顾问，正在帮申请者整理访谈内容，用简洁自然的语言归纳他们在某个维度的经历。`

      if (dimension === 'academic' && hasCv) {
        // Academic for CV users: extract directly from CV (interview may not cover this)
        userPrompt = `请根据申请者的简历，用第二人称（"你"）分点总结其【学术背景】。${cvBlock}

## 输出格式（严格遵守）：
- 每行一个要点，以「· 」开头，3-5 个要点，每点 20-40 字
- 必须具体：学校名称、专业、学制/毕业年份、GPA或成绩排名、代表性课程或研究方向
- **不要**包含任何项目、实习、科研经历——只写学校、专业、课程学习、学术成绩相关内容
- 不要泛泛而谈，不要重复，不要加标题或额外说明`
      } else if (isMultiEntry) {
        // 多条目维度：按每段经历分组，每组有标题 + 自然叙事要点
        // For CV users, prepend CV text so AI can enrich with CV details
        const cvContext = hasCv
          ? `申请者已提供简历，其中包含经历的基本信息；访谈对话则提供了更深入的细节。请综合两者进行总结，以访谈中的深挖内容为主，简历信息作为补充。${cvBlock}${cvAnalysisBlock}${cvNamesBlock}\n\n`
          : ''
        userPrompt = `${cvContext}请扫描以下完整访谈对话（包括所有话题），找出申请者在【${dimensionLabel}】方面**曾经提到过的所有经历**——无论是在正式讨论该话题时提及的，还是在其他话题中顺带提及的。
${claimedBlock ? `\n${claimedBlock}\n` : ''}
对话内容：
${conversationText}

## 输出格式（严格遵守）：
- **每一段经历都必须单独成组，不得遗漏**，即使某段只是一两句话的简短提及，包括课程作业/课程大作业/课程项目等顺带提及的经历
- 每组第一行**必须**为标题：「# 经历名称」（如公司名、项目名/竞赛名），之后每行一个要点，以「· 」开头，2-4 个要点
- 即使只有一段经历，也**必须**有标题行
- 每个要点写成一句完整的自然语句（15-40 字），**统一用第二人称"你"**，把角色/做了什么、方法/思路、遇到的挑战、如何解决、结果等叙事要素**有机融入句子里**，而不是拆成独立标签行——信息量多就多写一句，信息量少就精炼成一句
- 每句必须具体：提到真实名称、数据（时长/规模/成果）；访谈和简历中没有的内容不要编造
- **同一段经历只能出现一次**：对话中同一件事常被多次提及、用不同说法描述（如"模拟法庭"和"模拟法庭比赛"、"小额诉讼课程"和"小额诉讼程序课程作业"）——只要指向同一个活动/项目/赛事，无论名称是否完全一致，**必须合并为一组**，取最完整的名称作为标题
${excludeRule}- 不要泛泛而谈，不要重复，不要加额外说明

示例（有两段实习）：
# 字节跳动
· 你在商业化部门数据分析岗实习约 3 个月
· 你独立搭建了跨部门 A/B 测试体系，解决了各团队数据口径不一致的问题，新策略上线后点击率提升约 18%

# 腾讯
· 你在微信支付风控团队实习 2 个月，负责优化规则引擎
· 你通过分析误判样本调整特征权重，将误判率从 12% 降至 7% 并已上线`
      } else if (dimension === 'personal') {
        // 个人特质：专门提炼性格特质，不总结经历
        userPrompt = `请根据以下访谈对话，提炼申请者的核心个人特质。

对话内容：
${conversationText}

## 输出要求（严格遵守）：
- 每行一个特质，以「· 」开头，3-4 个要点，每点 15-35 字
- **每个要点描述一种性格特质或思维方式**（如：系统性思维、目标感强、韧性、好奇心驱动、善于反思等），用第二人称（"你"）表达
- 可以用一句话简短点明这个特质是如何体现的，但**重点是特质本身，不是事件经过**
- **不要罗列项目名称、公司名称、经历细节**——那些属于其他维度，这里只写特质
- 不要泛泛而谈（不要写"你是一个努力的人"），要有质感（"你在面对模糊问题时，习惯先动手做原型再反推逻辑"）
- 不要加标题或额外说明

示例：
· 你有很强的目标感，一旦认定方向就会主动寻找资源推进，不依赖外部推动
· 你习惯在行动中思考，遇到不确定的情况会先尝试、再总结，而非等到"想清楚"再动
· 你对细节有天然的敏感度，能在别人忽视的地方发现问题并持续打磨`
      } else {
        // 其他单条目维度（motivation/plan）：分点输出
        userPrompt = `请根据以下访谈对话，用第二人称（"你"）分点总结申请者在【${dimensionLabel}】方面的情况。

对话内容：
${conversationText}

## 输出格式（严格遵守）：
- 每行一个要点，以「· 」开头
- 3-5 个要点，每点 20-40 字
- 必须具体：提到真实名称（学校/专业/方向等）和关键信息
- 重点覆盖：${PARAGRAPH_FOCUS[dimension] || dimensionLabel}
${excludeRule}- 不要泛泛而谈，不要重复，不要加标题或额外说明

示例（申请动机）：
· 大三参与导师的 NLP 课题后，第一次感受到研究的成就感，由此确定了读研方向
· 希望深入研究大模型对话系统，国内相关项目资源有限，决定出国深造
· 目标院校的实验室在对话生成方向有持续发表，与研究兴趣高度匹配`
      }
    } else {
      // 结构化格式：供访谈侧边栏使用
      const isMultiEntry = ['project', 'internship', 'research'].includes(dimension)
      systemPrompt = `你是留学文书顾问，用极简方式记录申请者的核心经历信息。`

      if (dimension === 'academic' && hasCv) {
        // Academic for CV users: extract from CV
        userPrompt = `请根据申请者的简历，极简总结其【学术背景】最关键的 2-3 条信息。${cvBlock}

## 输出要求：
- 每行以「· 」开头，10-25 字，只写最核心的事实（学校、专业、成绩、毕业时间）
- **不要**包含项目、实习、科研经历
- 不加标题，不加说明，直接输出`
      } else if (isMultiEntry) {
        const cvContext = hasCv
          ? `申请者已提供简历（见下方），访谈对各经历进行了深挖。请综合两者，以访谈细节为主，简历信息为辅。${cvBlock}${cvAnalysisBlock}${cvNamesBlock}\n\n`
          : ''
        userPrompt = `${cvContext}请扫描以下完整访谈对话（包括所有话题），找出用户在【${dimensionLabel}】方面**曾经提到过的所有经历**，每段单独成组。
${claimedBlock ? `\n${claimedBlock}\n` : ''}
对话内容：
${conversationText}

## 输出格式：
- **每一段经历都必须列出，不得遗漏**，即使只有一两句话的简短提及，包括课程作业/课程大作业/课程项目等在对话中顺带提及的经历
- 每组首行**必须**写「# 经历名称」（公司名/项目名/竞赛名，10字以内），即使只有一段经历也要有标题行，下面 1-2 行以「· 」开头写核心事实；信息不足时写 1 点也可
- 每条要点 10-25 字，必须具体（名称、数字、结果），不写废话
- **同一段经历只能出现一次**：同一活动/项目在对话中被多次提及或用不同说法描述，只要指向同一件事，必须合并为一组，不要因名称措辞差异而拆成两组
${excludeRule}- 不加额外说明，直接输出

示例（两段实习）：
# 字节跳动
· 商业化部门数据分析岗，实习 3 个月
· A/B 测试方案，点击率提升 18%

# 腾讯
· 微信支付风控团队，实习 2 个月
· 误判率从 12% 降至 7%`
      } else if (dimension === 'personal') {
        userPrompt = `请从以下对话中提炼用户的 2-3 个核心个人特质，每条一行。

对话内容：
${conversationText}

## 输出要求：
- 每行以「· 」开头，10-20 字，只描述特质本身
- 写性格特质、思维方式（如"系统性思维"、"目标感强"、"韧性"），不写项目名称或经历细节
- 不加标题，不加说明，直接输出`
      } else {
        userPrompt = `请从以下对话中提取用户【${dimensionLabel}】最关键的 2-3 条信息，每条一行。

对话内容：
${conversationText}

## 输出要求：
- 每行以「· 」开头，10-25 字，只写最核心的事实
- 必须具体：名称、数字、结果，不写废话
${excludeRule}- 跳过没提到的内容，不写"未提及"
- 不加标题，不加说明，直接输出`
      }
    }

    let raw = await callDeepSeek(systemPrompt, userPrompt)
    raw = raw.replace(/^(总结|摘要)[：:]?\s*/i, '').replace(/^["'【]|["'】]$/g, '').trim()

    // For multi-entry dims: run a dedicated dedup pass so that the same experience
    // mentioned with different names at different points in the conversation is
    // always merged into one section.
    const isMultiEntryDim = ['project', 'internship', 'research'].includes(dimension)
    const sectionCount = (raw.match(/^# /gm) || []).length
    if (isMultiEntryDim && sectionCount >= 2) {
      try {
        const deduped = await callDeepSeek(
          `你是文本整理专家，任务是合并重复条目。`,
          `以下是申请者经历的分组列表，其中可能有多组描述的是**同一段经历**（名称措辞不同，但指向同一个活动、项目或赛事）。

${raw}

## 合并规则：
- 只要两组指向同一件事（哪怕一组叫"模拟法庭"、另一组叫"模拟法庭比赛"），**必须合并为一组**
- 合并时取最完整、最具体的标题
- 合并后的要点去重，保留信息量最大的表述
- 确实是不同经历的组**保持不变，不要合并**
- 输出格式与输入完全一致（# 标题 + · 要点），不加任何说明`
        )
        raw = deduped.replace(/^(总结|摘要)[：:]?\s*/i, '').replace(/^["'【]|["'】]$/g, '').trim()
      } catch {
        // dedup failed — use original
      }
    }

    return Response.json({ summary: raw })
  } catch (error) {
    console.error('[summarize-dimension] error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : '生成总结失败' },
      { status: 500 }
    )
  }
}
