import { callDeepSeek } from '@/lib/deepseek'
import { classifyInterviewQuestion } from '@/lib/interview-progress'
import type { Message } from '@/lib/types'

const DIMENSION_LABELS: Record<string, string> = {
  academic: '学术背景',
  research: '科研经历',
  internship: '实习经历',
  project: '项目经历',
  motivation: '申请动机',
  plan: '未来规划',
}

// 段落格式：面向申请者的自然语言叙述，用于高亮页 Step 1 展示
const PARAGRAPH_FOCUS: Record<string, string> = {
  academic:   '就读学校与专业、学术成绩、核心课程，以及从课程中掌握的知识、方法、能力与学习收获；完全不包含课程项目或毕设',
  research:   '研究机构/导师、课题方向、做了哪些具体工作、取得的成果或发现',
  internship: '实习公司与岗位、负责的核心项目或任务、遇到的挑战与解决方式、可量化成果',
  project:    '项目/活动名称与目的、采用的方法或思路（不限技术类）、遇到的难题与解决方式、最终结果或影响',
  motivation: '申请这个方向的具体触发点（哪件事/哪个时刻让你决定的）、为什么选择这个专业/学校、出国读书的深层动机',
  plan:       '毕业后的目标方向或职位、短期计划（1-2年）、长期愿景',
}

/**
 * Determine which messages to use for summarising a dimension.
 *
 * Multi-entry dimensions (project / internship / research):
 *   Use the FULL conversation so that experiences mentioned in passing during
 *   other sections are not missed.  The per-dimension exclusion rules in the
 *   prompt prevent cross-contamination.
 *
 * Single-entry dimensions (academic / motivation / plan):
 *   Slice to the dedicated Q&A window to avoid polluting the summary with
 *   unrelated content from elsewhere in the conversation.
 *
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
  // Older/persisted no-CV conversations may not contain machine markers. In
  // that case, locate the dedicated question itself instead of feeding the
  // whole conversation to motivation/plan summaries (which mixes in traits,
  // projects and career plans).
  if (start === -1) {
    const naturalStart: Record<string, RegExp> = {
      motivation: /(?:为什么|为何|是什么.*(?:让|使|促使)).*(?:申请|选择|深造|继续.*方向)|(?:申请|选择).*(?:原因|动机)|对[“\"「『]?.+?[”\"」』]?这个专业.*(?:理解|变化).*(?:申请|继续)/,
      plan: /(?:读完|完成).*(?:硕士|项目).*(?:之后|以后)|毕业后.*(?:方向|打算|想)|未来.*(?:规划|方向|打算)|职业.*(?:规划|方向|目标)/,
    }
    const pattern = naturalStart[dim]
    if (pattern) {
      start = messages.findIndex(message =>
        message.role === 'assistant' && pattern.test(message.content)
      )
    }
  }
  if (start === -1) return messages

  let end = messages.length
  for (let i = start + 1; i < messages.length; i++) {
    if (messages[i].role === 'assistant') {
      const m = src(messages[i]).match(/\[ASKING[：:]\s*([^\]]+)\]/i)
      if (m && m[1].trim() !== dim) { end = i; break }
      if (dim === 'motivation' && /(?:读完|完成).*(?:硕士|项目).*(?:之后|以后)|毕业后.*(?:方向|打算|想)|未来.*(?:规划|方向|打算)|职业.*(?:规划|方向|目标)/.test(messages[i].content)) {
        end = i; break
      }
    }
  }
  return messages.slice(start, end)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Remove course learning mistakenly promoted to a standalone project by the
 * summarizer. A course item is retained only when the conversation identifies
 * an independent deliverable such as a course project, design, paper or thesis.
 */
function removeCourseOnlyProjectSections(summary: string, messages: Message[]): string {
  if (!summary.includes('# ')) return summary
  const sections = summary.split(/(?=^# )/m).filter(Boolean)
  const explicitProjectCarrier = /大作业|课程作业|课程项目|课程设计|课程论文|毕业论文|毕业设计|独立项目|小组项目|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|模拟法庭|法律援助|个人项目|开源项目|社会实践|公益|志愿|社团/
  const routineCourseLearning = /(?:这门|该门|一门|核心|专业)?课程|课上|课堂|实验课|课程实验|观摩|仪器练习|学会|掌握|知识点/

  const kept = sections.filter(section => {
    const title = section.match(/^#\s*(.+)$/m)?.[1]?.trim() || ''
    if (!title) return true
    const titlePattern = new RegExp(escapeRegExp(title.replace(/[—–-].*$/, '').trim()))
    const relatedIndexes = messages.flatMap((message, index) =>
      titlePattern.test(message.content) ? [index] : [])
    const context = relatedIndexes.flatMap(index =>
      messages.slice(Math.max(0, index - 1), Math.min(messages.length, index + 3)))
      .map(message => message.content).join('\n')
    const looksLikeCourse = /课$|课程|课堂|课程实验|实验课/.test(title) || routineCourseLearning.test(context)

    return !looksLikeCourse || explicitProjectCarrier.test(context)
  })

  return kept.join('').trim() || '无'
}

/** Recover a project that the summarizer incorrectly calls empty. The window is
 * bounded by explicit project and post-project questions, so internships and
 * academic examples cannot be promoted accidentally. */
function recoverProjectSummary(messages: Message[]): string {
  const src = (message: Message) => message.rawContent ?? message.content
  const start = messages.findIndex(message => message.role === 'assistant' &&
    (message.questionDimension === 'project' ||
      /\[ASKING[：:]\s*project\]/i.test(src(message)) ||
      /(?:有没有|参加过|做过|聊聊|听听|接着看).{0,100}(?:竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|模拟法庭|法律援助|个人项目|开源项目|社会实践|志愿|社团|课程设计|毕业设计|大作业)/.test(src(message)) ||
      classifyInterviewQuestion(src(message)) === 'project'))
  if (start < 0) return '无'

  let end = messages.length
  for (let index = start + 1; index < messages.length; index++) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const dimension = message.questionDimension || classifyInterviewQuestion(src(message))
    if (['motivation', 'plan'].includes(dimension || '')) {
      end = index
      break
    }
  }
  const window = messages.slice(start, end)
  const answers = window.filter(message => message.role === 'user')
    .map(message => message.content.trim()).filter(Boolean)
  const identityAnswer = answers.find(answer =>
    /竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|模拟法庭|法律援助|个人项目|开源项目|社会实践|志愿|社团|课程设计|毕业设计|大作业/.test(answer)) || ''
  if (!identityAnswer || /^(?:没有|没|无|暂时没有)/.test(identityAnswer)) return '无'
  const title = identityAnswer.split(/[：:。；;！!\n]/)[0]
    .replace(/^(?:我)?有(?:过)?(?:一|二|两|三|四|几|多)?段?(?:相关的?)?/, '')
    .replace(/[\*#「」『』]/g, '').trim().slice(0, 20) || '项目经历'
  const bullets = answers.filter(answer => answer !== identityAnswer && answer.length >= 12)
    .flatMap(answer => answer.split(/[。！？\n]+/))
    .map(answer => answer.trim()).filter(answer => answer.length >= 12)
    .slice(0, 2).map(answer => `· ${answer.slice(0, 48)}`)
  return `# ${title}\n${bullets.length > 0 ? bullets.join('\n') : `· ${identityAnswer.slice(0, 48)}`}`
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
      structuredSummary = '',
      quickInfo = null,
    }: {
      dimension: string
      messages: Message[]
      format?: 'structured' | 'paragraph'
      relatedSummaries?: Record<string, string>
      cvText?: string
      cvAnalysis?: string
      structuredSummary?: string
      quickInfo?: { school?: string; major?: string; gpa?: string } | null
    } = await req.json()

    if (!dimension || !(dimension in DIMENSION_LABELS) || !rawMessages || !Array.isArray(rawMessages)) {
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
    const academicProfileBlock = dimension === 'academic' && quickInfo
      ? `\n\n【用户填写的学术基本信息——最高优先级事实】\n- 就读院校：${quickInfo.school?.trim() || '未填写'}\n- 就读专业：${quickInfo.major?.trim() || '未填写'}\n- GPA：${quickInfo.gpa?.trim() || '未填写'}\n已填写的院校、专业和 GPA 必须逐字使用，不得匿名化为“某高校/某大学/某院校”，也不得自行改写。`
      : ''

    // Extract experience names from cvAnalysis for use as canonical section titles
    const cvEntries: Array<{ name: string; type: string }> = []
    if (hasCv && cvAnalysis?.trim()) {
      let current: { name: string; type: string } | null = null
      for (const line of cvAnalysis.split('\n')) {
        const nameMatch = line.trim().match(/^经历名称[：:](.+)/)
        const typeMatch = line.trim().match(/^经历类型[：:](.+)/)
        if (nameMatch) {
          if (current) cvEntries.push(current)
          current = { name: nameMatch[1].trim(), type: '' }
        } else if (typeMatch && current) {
          current.type = typeMatch[1].trim()
        }
      }
      if (current) cvEntries.push(current)
    }
    const dimensionToType: Record<string, string> = {
      research: '科研经历',
      internship: '实习经历',
      project: '项目经历',
    }
    const requiredCvEntryNames = dimensionToType[dimension]
      ? cvEntries.filter(entry => entry.type === dimensionToType[dimension]).map(entry => entry.name)
      : cvEntries.map(entry => entry.name)
    const cvNamesBlock = requiredCvEntryNames.length > 0
      ? `\n\n【系统固定清单】以下是本维度必须输出的全部经历。**每一项都必须出现且只能出现一次**，标题必须逐字使用清单名称，不得遗漏、改名或合并：\n${requiredCvEntryNames.map(n => `- # ${n}`).join('\n')}`
      : ''

    // In no-CV interviews, the server state machine assigns one immutable id to
    // every experience being interviewed. Use those ids as the source of truth
    // for entry count; an LLM may polish names and wording, but must not merge two
    // independently queued experiences merely because their themes are similar.
    const directAnswerFor = (questionIndex: number) => {
      const question = rawMessages[questionIndex]
      if (question?.id) {
        const boundAnswer = rawMessages.find(message =>
          message.role === 'user' && message.replyToMessageId === question.id)
        if (boundAnswer?.content.trim()) return boundAnswer.content.trim()
      }
      const nextMessage = rawMessages[questionIndex + 1]
      return nextMessage?.role === 'user' ? nextMessage.content.trim() : ''
    }
    const subjectAnchors = new Map<string, { name: string; answers: string[] }>()
    if (!hasCv && ['project', 'internship', 'research'].includes(dimension)) {
      rawMessages.forEach((message, index) => {
        if (message.role !== 'assistant' ||
            message.questionDimension !== dimension ||
            !message.questionSubjectId ||
            !message.questionSubject?.trim()) return
        const answer = directAnswerFor(index)
        const existing = subjectAnchors.get(message.questionSubjectId) || {
          name: message.questionSubject.trim(),
          answers: [],
        }
        if (answer && !existing.answers.includes(answer)) existing.answers.push(answer)
        subjectAnchors.set(message.questionSubjectId, existing)
      })
    }
    const confirmedSubjectAnchors = [...subjectAnchors.entries()]
      .filter(([, anchor]) => anchor.answers.length > 0)
      .map(([id, anchor]) => ({ id, ...anchor }))
    const messageNamesBlock = confirmedSubjectAnchors.length > 0
      ? `\n\n【状态机确认的独立经历清单】以下每个 ID 都代表一段不同经历。必须按顺序各输出一组，不得因为类型、主题或能力相似而合并；标题可根据对话补充得更准确：\n${confirmedSubjectAnchors.map((anchor, index) => `${index + 1}. ${anchor.name}（ID: ${anchor.id}）`).join('\n')}`
      : ''
    const buildAnchoredFallback = () => confirmedSubjectAnchors.map(anchor => {
      const sentences = anchor.answers
        .flatMap(answer => answer.split(/[。！？\n]+/))
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 8)
      const uniqueSentences = [...new Set(sentences)].slice(0, format === 'paragraph' ? 4 : 2)
      const bullets = uniqueSentences.length > 0
        ? uniqueSentences.map(sentence => `· ${sentence.replace(/^我/, '你').slice(0, format === 'paragraph' ? 70 : 48)}`)
        : ['· 已在访谈中完成该经历的相关讨论']
      return `# ${anchor.name.slice(0, 24)}\n${bullets.join('\n')}`
    }).join('\n\n')

    let systemPrompt: string
    let userPrompt: string

    // 各维度的排除规则（防止跨维度内容混入）
    const DIM_EXCLUDE: Record<string, string> = {
      academic:   '**不要**包含任何可独立讲述的项目经历（课程作业、课程项目、课程设计、课程论文、毕业论文/毕业设计、个人项目、竞赛等）；只包含学校、专业、学术成绩、核心课程，以及课程带来的知识、方法、能力与收获。课堂中的常规课程实验、仪器练习和课程实操属于课程能力，应保留在学术背景，但不得另建项目标题',
      motivation: '**不要**包含对具体项目或经历的描述——这些有独立维度；只包含申请动机本身（为什么选这个专业/学校/国家，触发申请的契机）',
      project:    '**包含**：具有独立目标、个人任务、实施过程和可辨识产出的课程作业/课程项目、课程设计、普通毕业设计、个人项目、竞赛/比赛、学生组织或志愿活动。**课程名称、课堂案例、常规课程实验、仪器练习、课程实操，以及课程带来的知识/方法/技能本身不是项目，绝对不能单独成组**。**不要**包含：实习、任何已发表或投稿的论文、依托正式实验室/课题组的研究、正式科研课题；同一论文或科研课题即使在项目话题中再次提到，也只能归入科研经历一次',
      internship: '**不要**包含课程项目、个人项目、竞赛等非实习内容，也不要包含科研课题或学术论文。**特别注意**：导师横向课题、纵向课题、实验室科研项目等属于科研经历，**绝对不能**归入实习经历，即使是在实习期间参与的',
      research:   '**包含**：正式加入导师实验室/课题组并持续参与的科研课题、发表或投稿的学术论文，以及依托正式实验室/课题组并形成论文或投稿的毕设。**不要**包含：普通毕业设计、课程作业/课程项目（无发表）、竞赛、社团活动、实习岗位本身',
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
        // If the sidebar already identified experiences in structured format, anchor to that list
        const structuredTitles = structuredSummary
          ? structuredSummary.split('\n').filter(l => l.startsWith('# ')).map(l => l.slice(2).trim()).filter(Boolean)
          : []
        const anchorBlock = structuredTitles.length > 0
          ? `【已识别的经历清单——必须全部覆盖】以下经历已在访谈中被识别，**每一条都必须出现在输出中**，不得遗漏：\n${structuredTitles.map(t => `- ${t}`).join('\n')}\n\n`
          : ''
        userPrompt = `${cvContext}${anchorBlock}${messageNamesBlock}请扫描以下完整访谈对话（包括所有话题），找出申请者在【${dimensionLabel}】方面**曾经提到过的所有经历**——无论是在正式讨论该话题时提及的，还是在其他话题中顺带提及的。
${claimedBlock ? `\n${claimedBlock}\n` : ''}
对话内容：
${conversationText}

## 输出格式（严格遵守）：
- **每一段经历都必须单独成组，不得遗漏**，即使某段只是一两句话的简短提及，包括课程作业/课程大作业/课程项目等顺带提及的经历
${dimension === 'project' ? '- 只有同时出现独立目标、用户承担的具体任务、实施过程和可辨识产出，才算一段项目经历；常规课程实操、仪器练习、掌握某种工具或谈论课程收获不能生成项目标题。凡是论文、投稿或正式科研课题，即使对话中重复出现，也不得归入项目\n' : ''}
- 每组第一行**必须**为标题：「# 经历名称」（如公司名、项目名/竞赛名），之后每行一个要点，以「· 」开头，3-5 个要点
- 即使只有一段经历，也**必须**有标题行
- 每个要点写成一句完整的自然语句（25-70 字），**统一用第二人称"你"**。每段经历应尽量分别覆盖：背景与个人角色、核心问题或挑战、采取的方法与关键判断、结果或影响、反思与能力变化；不得只写“做了什么＋结果”，也不得使用省略号（…或...）
- 每句必须具体：提到真实名称、数据（时长/规模/成果）；访谈和简历中没有的内容不要编造
- **同一段经历只能出现一次**：对话中同一件事常被多次提及、用不同说法描述（如"模拟法庭"和"模拟法庭比赛"、"小额诉讼课程"和"小额诉讼程序课程作业"）——只要指向同一个活动/项目/赛事，无论名称是否完全一致，**必须合并为一组**，取最完整的名称作为标题
- **不同公司、机构、比赛或项目必须保持独立**：即使岗位、行业、职责或能力主题高度相似，也绝对不能合并、互相借用要点或使用“含另一方向”等组合标题。尤其两家公司中的法务实习必须逐家公司分别完整总结
- **但同一课程/机构下的不同角色必须拆分**：如果申请者在同一门课里既以学生身份完成了课程项目，又以助教身份辅导其他同学——这是两件不同的事，**必须各自独立成组**（如「X课程——课程项目」和「X课程——助教」），不得因共享同一课程名就强行合并
${excludeRule}- 不要泛泛而谈，不要重复，不要加额外说明

示例（有两段实习）：
# 字节跳动
· 你在商业化部门数据分析岗实习约 3 个月
· 你独立搭建了跨部门 A/B 测试体系，解决了各团队数据口径不一致的问题，新策略上线后点击率提升约 18%

# 腾讯
· 你在微信支付风控团队实习 2 个月，负责优化规则引擎
· 你通过分析误判样本调整特征权重，将误判率从 12% 降至 7% 并已上线`
      } else {
        // 其他单条目维度（motivation/plan）：分点输出
        userPrompt = `${academicProfileBlock}请根据以下访谈对话，用第二人称（"你"）分点总结申请者在【${dimensionLabel}】方面的情况。

对话内容：
${conversationText}

## 输出格式（严格遵守）：
- 每行一个要点，以「· 」开头
- 3-5 个要点，每点 20-40 字
- 必须具体：提到真实名称（学校/专业/方向等）和关键信息
- 重点覆盖：${PARAGRAPH_FOCUS[dimension] || dimensionLabel}
${dimension === 'motivation' ? '- 只保留“为什么申请/继续深造”：认知转变、申请触发点、选择该专业或院校的理由；排除个人特质与毕业后的职位规划\n' : ''}${dimension === 'plan' ? '- 只保留硕士毕业后的职业方向、工作领域、读博打算及长期目标；排除申请理由与个人特质\n' : ''}
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
        userPrompt = `${cvContext}${messageNamesBlock}请扫描以下完整访谈对话（包括所有话题），找出用户在【${dimensionLabel}】方面**曾经提到过的所有经历**，每段单独成组。
${claimedBlock ? `\n${claimedBlock}\n` : ''}
对话内容：
${conversationText}

## 输出格式：
- 如果对话中**完全没有**提及任何符合本维度定义的经历，只输出「无」，不要编造或解释
- **每一段经历都必须列出，不得遗漏**，即使只有一两句话的简短提及，包括课程作业/课程大作业/课程项目等在对话中顺带提及的经历
${dimension === 'project' ? '- 只有同时出现了可识别的具体任务/活动，以及用户实际完成的动作或产出，才算一段项目经历；仅仅学习某门课程、掌握某种分析框架或谈论课程收获，不能生成项目标题\n' : ''}
${dimension === 'project' ? '- 不同载体必须分开：课程实操实验、另一门课的课程论文、课程外志愿/公益活动是三段独立经历，即使主题相同、彼此启发或形成连续故事，也绝对不能合并或遗漏\n' : ''}
- 每组首行**必须**写「# 经历名称」（公司名/项目名/竞赛名，10字以内），即使只有一段经历也要有标题行，下面 1-2 行以「· 」开头写核心事实；信息不足时写 1 点也可
- 每条要点 10-25 字，必须具体（名称、数字、结果），不写废话，**不得使用省略号（…或...）**，信息量大时精炼成完整句而非截断
- **同一段经历只能出现一次**：同一活动/项目在对话中被多次提及或用不同说法描述，只要指向同一件事，必须合并为一组，不要因名称措辞差异而拆成两组
- **但同一课程/机构下的不同角色必须拆分**：如申请者在同一门课里既完成了课程项目，又担任了助教——这是两件事，必须各自独立成组（如「X课程——课程项目」和「X课程——助教」）
${excludeRule}- 不加额外说明，直接输出

示例（两段实习）：
# 字节跳动
· 商业化部门数据分析岗，实习 3 个月
· A/B 测试方案，点击率提升 18%

# 腾讯
· 微信支付风控团队，实习 2 个月
· 误判率从 12% 降至 7%`
      } else {
        userPrompt = `${academicProfileBlock}请从以下对话中提取用户【${dimensionLabel}】最关键的 2-3 条信息，每条一行。

对话内容：
${conversationText}

## 输出要求：
- 每行以「· 」开头，10-25 字，只写最核心的事实
- 必须具体：名称、数字、结果，不写废话
${dimension === 'motivation' ? '- 只写“为什么申请/继续深造”：包括认知转变、申请触发点、选择该专业或院校的理由；不要写性格特质，也不要把毕业后的职位方向写成申请动机\n' : ''}${dimension === 'plan' ? '- 只写硕士毕业后的职业方向、工作领域、读博打算及长期目标；不要重复申请院校、申请理由或个人性格评价\n' : ''}
${excludeRule}- 跳过没提到的内容，不写"未提及"
- 不加标题，不加说明，直接输出`
      }
    }

    let raw = await callDeepSeek(systemPrompt, userPrompt)
    raw = raw.replace(/^(总结|摘要)[：:]?\s*/i, '').replace(/^["'【]|["'】]$/g, '').trim()
    if (/^(?:#\s*)?(?:[·•・]\s*)?(?:无|暂无|没有(?:对应)?(?:经历|内容)?)[。.]?$/i.test(raw)) raw = '无'

    if (dimension === 'academic' && quickInfo?.school?.trim()) {
      const school = quickInfo.school.trim()
      raw = raw.replace(/某(?:高校|大学|院校)/g, school)
      if (!raw.includes(school)) {
        const identity = [
          `就读于${school}`,
          quickInfo.major?.trim() ? `${quickInfo.major.trim()}专业` : '',
          quickInfo.gpa?.trim() ? `GPA ${quickInfo.gpa.trim()}` : '',
        ].filter(Boolean).join('，')
        raw = `· ${identity}\n${raw}`.trim()
      }
    }

    if (dimension === 'project' && !hasCv && raw === '无') {
      raw = recoverProjectSummary(rawMessages)
    }

    // Model extraction is advisory; enforce the course-vs-project boundary in
    // code so future interviews do not depend on a particular wording or model.
    if (dimension === 'project' && !hasCv) {
      raw = removeCourseOnlyProjectSections(raw, rawMessages)
    }

    const anchoredMinimumCount = confirmedSubjectAnchors.length
    if (anchoredMinimumCount > 0 && (raw.match(/^# /gm) || []).length < anchoredMinimumCount) {
      raw = buildAnchoredFallback()
    }

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
- **只有**两组确实是同一个活动/项目/赛事（同一时间、同一作业/任务、只是名称措辞不同），才合并。例如"模拟法庭"和"模拟法庭比赛"指同一场活动，可合并
- **以下情况绝对不得合并**，即使主题相近或都涉及同类行业：
  - 不同课程的作业/项目（如"消费者行为学课程项目"和"市场调研课程项目"是两门课的两个作业，不得合并）
  - 不同时间完成的不同任务
  - 同一课程/机构下的不同角色（如"课程项目"和"助教"）
- 合并时取最完整、最具体的标题
- 合并后的要点去重，保留信息量最大的表述
- 输出格式与输入完全一致（# 标题 + · 要点），不加任何说明`
        )
        const cleanedDeduped = deduped.replace(/^(总结|摘要)[：:]?\s*/i, '').replace(/^["'【]|["'】]$/g, '').trim()
        const dedupedCount = (cleanedDeduped.match(/^# /gm) || []).length
        // A thematic link is not duplication. If the model collapses most of the
        // independent activities, keep the original exhaustive extraction.
        const minimumDedupedCount = Math.max(Math.ceil(sectionCount / 2), anchoredMinimumCount)
        if (dedupedCount >= minimumDedupedCount) raw = cleanedDeduped
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
