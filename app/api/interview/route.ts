import { streamDeepSeek } from '@/lib/deepseek'
import { buildInterviewSystemPrompt } from '@/lib/prompts'
import type { Message } from '@/lib/types'
import {
  classifyInterviewQuestion,
  extractPreScreenAvailability,
  getAcademicCourseGap,
  getUncoveredFocusCourses,
  hasCompleteAcademicBackgroundEvidence,
} from '@/lib/interview-progress'

const ALL_DIMENSIONS = ['academic', 'research', 'internship', 'project', 'motivation', 'plan']

export async function POST(req: Request) {
  const {
    messages,
    coveredDimensions = [],
    deferredDimensions = [],
    emptyDimensions = [],
    cvText = '',
    cvAnalysis = '',
    quickInfo = null,
    activeExperience = '',
    completedExperiences = [],
    startedExperiences = [],
    skippedQuestionIds = [],
    controlAction = '',
    controlQuestionId = '',
  }: { messages: Message[]; coveredDimensions?: string[]; deferredDimensions?: string[]; emptyDimensions?: string[]; cvText?: string; cvAnalysis?: string; quickInfo?: { school: string; major: string; gpa: string; targetSchool: string; targetMajor: string; degree: string } | null; activeExperience?: string; completedExperiences?: string[]; startedExperiences?: string[]; skippedQuestionIds?: string[]; controlAction?: 'rephrase' | 'skip' | ''; controlQuestionId?: string } = await req.json()

  const skippedQuestionIdSet = new Set(skippedQuestionIds)
  const controlTargetQuestion = controlQuestionId
    ? messages.find(message => message.role === 'assistant' && message.id === controlQuestionId)
    : undefined

  // Program-level queue guard for CV interviews. Dimension tags emitted by the
  // model are not trusted while typed experiences in that dimension remain.
  const cvEntries: Array<{ name: string; type: string }> = []
  let currentCvEntry: { name: string; type: string } | null = null
  for (const raw of cvAnalysis.split('\n')) {
    const line = raw.trim()
    if (/^经历名称[：:]/.test(line)) {
      if (currentCvEntry) cvEntries.push(currentCvEntry)
      currentCvEntry = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '' }
    } else if (/^经历类型[：:]/.test(line) && currentCvEntry) {
      currentCvEntry.type = line.replace(/^经历类型[：:]/, '').trim()
    }
  }
  if (currentCvEntry) cvEntries.push(currentCvEntry)
  const normalizeName = (name: string) => name.toLowerCase().replace(/[\s\-_*"“”'‘’「」【】《》()（）]/g, '')
  const isLikelyExperienceAlias = (leftRaw: string, rightRaw: string) => {
    const left = normalizeName(leftRaw)
    const right = normalizeName(rightRaw)
    if (!left || !right) return false
    if (left.includes(right) || right.includes(left)) return true
    const carrier = /(模拟法庭|法律援助|课程论文|课程研究|小组研究|小组报告|课程设计|毕业设计|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|实习|科研|课题)/g
    const leftCarrier = left.match(carrier)?.join('') || ''
    const rightCarrier = right.match(carrier)?.join('') || ''
    if (!leftCarrier || leftCarrier !== rightCarrier) return false
    const pairs = (value: string) => new Set(Array.from(
      { length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2),
    ))
    const leftPairs = pairs(left)
    const rightPairs = pairs(right)
    const overlap = [...leftPairs].filter(pair => rightPairs.has(pair)).length
    return overlap / Math.max(1, Math.min(leftPairs.size, rightPairs.size)) >= 0.55
  }
  const completedNames = completedExperiences.map(normalizeName)
  const pendingEntries = cvEntries.filter(entry => !completedNames.includes(normalizeName(entry.name)))
  const typeToDimension: Record<string, string> = {
    项目经历: 'project',
    实习经历: 'internship',
    科研经历: 'research',
  }
  let effectiveCoveredDimensions = coveredDimensions.filter(dimension => {
    if (!ALL_DIMENSIONS.includes(dimension)) return false
    if (!cvText.trim()) return true
    if (['motivation', 'plan'].includes(dimension)) return pendingEntries.length === 0
    return !pendingEntries.some(entry => typeToDimension[entry.type] === dimension)
  })

  // No-CV project discovery starts with higher-value extracurricular carriers
  // (competitions and personal projects). Course work is only a fallback when
  // the total remains below the 3–4 useful-experience target.
  const messageSource = (message: Message) => message.rawContent ?? message.content
  const taggedExperienceNames = messages.flatMap(message =>
    message.role === 'assistant'
      ? Array.from(messageSource(message).matchAll(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/gi), match => match[1].trim())
      : [])
  const experienceValueByName = new Map<string, 'high' | 'medium' | 'low'>()
  const experienceDimensionByName = new Map<string, string>()
  const qualifiedProjectExperienceNames = new Set<string>()
  const completedTaggedExperienceNames: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const source = messageSource(message)
    const metadataDimension = message.questionDimension ||
      source.match(/\[ASKING[：:]\s*(academic|research|internship|project|motivation|plan)\]/i)?.[1] || ''
    if (metadataDimension && message.questionSubject) {
      experienceDimensionByName.set(normalizeName(message.questionSubject), metadataDimension)
    }
    for (const match of source.matchAll(/\[EXP(?:_DONE)?[：:]\s*([^\]]+)\]/gi)) {
      const normalizedName = normalizeName(match[1])
      if (metadataDimension) experienceDimensionByName.set(normalizedName, metadataDimension)
      // A project must be opened through an unmistakable independent carrier.
      // Generic academic questions about a "small project or experiment" are
      // course-depth evidence and cannot silently become a counted project.
      const explicitlyOpensIndependentProject =
        /(?:课程(?:中|里|之外|以外)|课外|课堂之外).{0,40}(?:大作业|课程项目|课程设计|课程论文|毕业论文|毕业设计|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|个人项目|社会实践|公益|志愿|社团|学生组织)|(?:有没有|参加过|做过|投入过|接下来聊|接着看).{0,30}(?:大作业|课程设计|课程论文|毕业设计|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|个人项目|社会实践|公益|志愿|社团|学生组织)/.test(source)
      if (metadataDimension === 'project' && explicitlyOpensIndependentProject) {
        qualifiedProjectExperienceNames.add(normalizedName)
      }
    }
    for (const match of source.matchAll(/\[EXP_VALUE[：:]\s*([^|\]]+)\|(high|medium|low)\]/gi)) {
      experienceValueByName.set(normalizeName(match[1]), match[2].toLowerCase() as 'high' | 'medium' | 'low')
    }
    for (const match of source.matchAll(/\[EXP_DONE[：:]\s*([^\]]+)\]/gi)) {
      completedTaggedExperienceNames.push(match[1].trim())
    }
  }
  const inferredInternshipNames = messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return []
    const source = messageSource(message)
    const belongsToInternship = message.questionDimension === 'internship' ||
      /\[ASKING[：:]\s*internship\]/i.test(source)
    if (!belongsToInternship || !/(?:第[一二两三]|下一段|另一段).{0,12}实习|哪家公司|什么公司.{0,8}岗位/.test(source)) return []
    const answer = messages.slice(index + 1).find(candidate => candidate.role === 'user')?.content.trim() || ''
    if (!answer || /^(?:没有|没|无|想不起来)/.test(answer)) return []
    // The opening clause normally contains the organization/role and is stable
    // enough to distinguish separately introduced internships.
    const identity = answer.split(/[。；;！!\n]/)[0].trim().slice(0, 40)
    return identity.length >= 2 ? [identity] : []
  })
  const PROJECT_NAME_CARRIER = /(?:模拟法庭|法律援助|课程论文|课程研究|小组研究|小组报告|课程设计|毕业设计|大作业|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|个人项目|开源项目|社会实践|志愿|公益|社团|学生组织)/
  const parseProjectInventoryLine = (rawLine: string) => {
    const cleaned = rawLine
      .replace(/^\s*(?:\d+[.、)]|[一二三四五六]+[、.)]|[-•·])\s*/, '')
      .replace(/^(?:我)?(?:参加过|参与过|做过|有过)\s*/, '')
      .trim()
    if (!cleaned) return []

    // Applicants commonly put several named competitions on one line joined by
    // “和/以及”. Split only when at least two fragments independently contain a
    // project carrier, so prose such as “负责清洗和建模” stays inside one story.
    const fragments = cleaned
      .split(/(?:、|，|,|；|;|以及|还有|和)/)
      .map(fragment => fragment.trim())
      .filter(Boolean)
    const namedFragments = fragments.filter(fragment => PROJECT_NAME_CARRIER.test(fragment))
    const candidates = namedFragments.length >= 2 ? namedFragments : [cleaned]

    return candidates.flatMap(rawCandidate => {
      const candidate = rawCandidate.replace(/^(?:一|二|两|三|四)?段\s*/, '').trim()
      if (!PROJECT_NAME_CARRIER.test(candidate)) return []
      const identity = candidate.split(/[：:。；;！!]/)[0]
        .replace(/[\*#「」『』《》]/g, '').trim().slice(0, 40)
      if (/^(?:我)?有(?:过)?(?:一|二|两|三|四|几|多)?段?(?:相关的?)?(?:竞赛|比赛|大赛|个人项目|开源项目|项目|实践)(?:经历)?[了呢啊吧。！!\s]*$/.test(identity)) return []
      if (/^(?:这|该|那)(?:篇|个|项|段).{0,30}(?:是|由|属于|完成|负责|获得|得到)/.test(identity)) return []
      return identity.length >= 2 ? [identity] : []
    })
  }
  const NEGATIVE_INVENTORY_ANSWER = /^(?:没有|没|无|没有了|没了|也没有|都没有|想不到|暂时没有|好像没有)[了呢啊吧。！!\s]*$/
  const parseGenericProjectInventory = (answer: string) => {
    const trimmed = answer.trim()
    if (!trimmed || NEGATIVE_INVENTORY_ANSWER.test(trimmed)) return []

    // The inventory question itself establishes that these are project
    // candidates. Parse the applicant's list structure instead of requiring a
    // known carrier word such as “商赛/建模赛”. This supports future, unseen
    // competition and activity names.
    const enumerated = trimmed
      .replace(/[，,；;、]\s*(?=(?:一|二|两|三|四|五|六|七|八|九|十|\d+)\s*(?:段|个|项)[^，,；;、])/g, '\n')
      .split(/\n+/)
      .map(line => line.trim())
      .filter(Boolean)
    const semicolonOrList = enumerated.length > 1
      ? enumerated
      : trimmed.split(/[；;、\n]+/).map(line => line.trim()).filter(Boolean)

    return semicolonOrList.flatMap(rawCandidate => {
      const candidate = rawCandidate
        .replace(/^\s*(?:\d+[.、)]|[一二两三四五六七八九十]+[、.)])\s*/, '')
        .replace(/^(?:我)?(?:有|参加过|参与过|做过)?\s*(?:一|二|两|三|四|五|六|七|八|九|十|\d+)?\s*(?:段|个|项)\s*/, '')
        .trim()
      if (!candidate) return []
      const identity = candidate.split(/[：:。！!]/)[0]
        .replace(/[\*#「」『』《》]/g, '').trim().slice(0, 60)
      if (identity.length < 2 || /^(?:相关)?(?:项目|比赛|竞赛|实践|活动)(?:经历)?$|^经历$/.test(identity)) return []
      return [identity]
    }).slice(0, 8)
  }
  type ProjectQueueItem = { id: string; name: string; order: number }
  const inventoryProjectQueue: ProjectQueueItem[] = []
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant' || skippedQuestionIdSet.has(message.id || '') ||
        !['project_inventory', 'project_supplemental_inventory', 'project_identify_experience']
          .includes(message.questionObjective || '')) continue
    const reply = message.id
      ? messages.find(candidate => candidate.role === 'user' && candidate.replyToMessageId === message.id)
      : messages.slice(messageIndex + 1).find(candidate => candidate.role === 'user')
    if (!reply) continue
    const names = parseGenericProjectInventory(reply.content)
    names.forEach((name, itemIndex) => {
      if (inventoryProjectQueue.some(item => normalizeName(item.name) === normalizeName(name))) return
      const anchor = message.id || `message-${messageIndex}`
      inventoryProjectQueue.push({
        id: `project:${anchor}:${itemIndex + 1}`,
        name,
        order: inventoryProjectQueue.length,
      })
    })
  }
  const inferredProjectNames = messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return []
    const source = messageSource(message)
    const belongsToProject = message.questionDimension === 'project' ||
      /\[ASKING[：:]\s*project\]/i.test(source)
    const opensConcreteProject = /有没有.{0,20}(?:大作业|课程设计|课程论文|毕业设计|竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|个人项目|社团|志愿)|哪(?:一|个|项).{0,16}(?:项目|设计|作业|活动)|(?:参加过|做过).{0,12}(?:什么|哪些).{0,12}(?:竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|项目|实践|活动)|(?:什么|哪些).{0,12}(?:竞赛|比赛|大赛|商赛|建模赛|创业赛|创赛|个人项目|实践)|(?:是什么|具体是).{0,12}(?:比赛|竞赛|大赛|商赛|建模赛|创业赛|创赛|项目|实践|活动)/.test(source)
    if (!belongsToProject || !opensConcreteProject) return []
    const answer = messages.slice(index + 1).find(candidate => candidate.role === 'user')?.content.trim() || ''
    if (!answer || /^(?:没有|没|无|都没有|想不到|暂时没有)/.test(answer)) return []
    // Preserve every item from a numbered/bulleted inventory. Previously only
    // the first line survived, so the second announced project disappeared.
    const lines = answer.split(/\n+/).map(line => line.trim()).filter(Boolean)
    const candidateLines = lines.length > 1 ? lines : answer.split(/[；;]/).map(line => line.trim()).filter(Boolean)
    return candidateLines.flatMap(parseProjectInventoryLine)
  })
  // Numbered user inventories are authoritative even when the preceding
  // question used wording outside the classifier's patterns.
  const directlyDeclaredProjectNames = messages.flatMap(message => {
    if (message.role !== 'user') return []
    const lines = message.content.split(/\n+/).map(line => line.trim()).filter(Boolean)
    if (lines.filter(line => /^\s*(?:\d+[.、)]|[一二三四五六]+[、.)])/.test(line)).length < 2) return []
    return lines.flatMap(parseProjectInventoryLine)
  })
  // Once the advisor has visibly opened a project, its EXP/state identity is part
  // of the authoritative queue even if the applicant originally used shorthand
  // that the inventory parser did not recognize.
  const stateOpenedProjectNames = [
    ...taggedExperienceNames,
    ...startedExperiences,
    ...(activeExperience ? [activeExperience] : []),
  ].filter(name =>
    experienceDimensionByName.get(normalizeName(name)) === 'project' ||
    PROJECT_NAME_CARRIER.test(name))
  // Structured inventory is the only queue source for protocol-v2 interviews.
  // Legacy extraction is an all-or-nothing fallback for old transcripts; mixing
  // both sources turns “有一段X” and “X” into two separate experiences.
  const legacyDiscoveredProjectNames = Array.from(new Set([
    ...inferredProjectNames,
    ...directlyDeclaredProjectNames,
    ...stateOpenedProjectNames,
  ]))
  const allDiscoveredProjectNames = inventoryProjectQueue.length > 0
    ? inventoryProjectQueue.map(item => item.name)
    : legacyDiscoveredProjectNames
  const projectQueueItems: ProjectQueueItem[] = [...inventoryProjectQueue]
  for (const name of allDiscoveredProjectNames) {
    if (projectQueueItems.some(item => normalizeName(item.name) === normalizeName(name))) continue
    projectQueueItems.push({
      id: `project:legacy:${projectQueueItems.length + 1}`,
      name,
      order: projectQueueItems.length,
    })
  }
  const getDirectAnswer = (questionIndex: number) => {
    const question = messages[questionIndex]
    if (!question || question.role !== 'assistant') return undefined
    if (question.id) {
      const explicitlyBound = messages.find(candidate =>
        candidate.role === 'user' && candidate.replyToMessageId === question.id)
      if (explicitlyBound) return explicitlyBound
    }
    for (let index = questionIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === 'assistant') break
      if (messages[index].role === 'user') return messages[index]
    }
    return undefined
  }
  const getProjectQueueProgress = (item: ProjectQueueItem) => {
    const answeredObjectives = new Set<string>()
    let hasIdBoundQuestion = false
    messages.forEach((message, index) => {
      if (message.role !== 'assistant' || message.questionSubjectId !== item.id) return
      hasIdBoundQuestion = true
      const answer = getDirectAnswer(index)
      if (answer?.content.trim() || skippedQuestionIdSet.has(message.id || '')) {
        answeredObjectives.add(message.questionObjective || '')
      }
    })
    const contributionAnswered = answeredObjectives.has('project_open_experience')
    const processAnswered = answeredObjectives.has('project_deep_dive_process')
    const outcomeAnswered = answeredObjectives.has('project_deep_dive_outcome')
    return {
      hasIdBoundQuestion,
      contributionAnswered,
      processAnswered,
      outcomeAnswered,
      complete: contributionAnswered && processAnswered && outcomeAnswered,
    }
  }
  const getExperienceEvidence = (experienceName: string, experienceId = '') => {
    const startIndex = messages.findIndex(message => {
      if (message.role !== 'assistant') return false
      if (experienceId && message.questionSubjectId === experienceId) return true
      const source = messageSource(message)
      const tagged = source.match(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/i)?.[1] || ''
      return (tagged && isLikelyExperienceAlias(tagged, experienceName)) ||
        Boolean(message.questionSubject && isLikelyExperienceAlias(message.questionSubject, experienceName))
    })
    if (startIndex < 0) return null
    const evidenceReplies: string[] = []
    for (let index = startIndex + 1; index < messages.length; index++) {
      const message = messages[index]
      if (message.role === 'assistant') {
        if (experienceId && message.questionSubjectId && message.questionSubjectId !== experienceId) break
        const nextName = messageSource(message).match(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/i)?.[1] || ''
        const nextSubject = ['research', 'internship', 'project'].includes(message.questionDimension || '')
          ? message.questionSubject || ''
          : ''
        if ((nextName && !isLikelyExperienceAlias(nextName, experienceName)) ||
            (nextSubject && !isLikelyExperienceAlias(nextSubject, experienceName))) break
      } else if (message.content.trim().length >= 20) {
        evidenceReplies.push(message.content.trim())
      }
    }
    const evidence = evidenceReplies.join('\n')
    const hasContribution = /我.{0,12}(?:负责|承担|主导|完成|搭建|建立|设计|实现|分析|清洗|建模|撰写|组织|协调|提出|选择|决定|处理)/.test(evidence)
    const hasChallenge = /(?:遇到|面临|出现|发现|存在).{0,24}(?:问题|困难|挑战|偏差|异常|不足|瓶颈|冲突|不一致|不合理)|(?:异常值|极端样本).{0,24}(?:直接删除|全部保留|损失|干扰|偏离)|(?:推翻|修正).{0,20}(?:预设|假设|原有思路)|(?:困难|挑战|难点|瓶颈|冲突|数据缺失|样本不平衡)/.test(evidence)
    const hasSolution = /(?:为了解决|针对|于是|因此|随后|通过).{0,40}(?:调整|改进|筛选|比较|验证|重做|重新|处理|解决|采用|引入|建立|设计)|(?:没有一刀切|结合.{0,20}(?:含义|实际|业务).{0,20}(?:区分|判断|保留|剔除)|修正剔除|对比.{0,20}(?:模型|结果|输出|方案)|我以.{0,30}(?:结果|数据|分析).{0,20}(?:说服|证明)|(?:维持|精简|改用|采用|搭配).{0,30}(?:定价|sku|模式|方案|结构))/i.test(evidence)
    // “结果解读” describes a responsibility, not an achieved outcome. Require
    // an explicit result predicate instead of accepting the bare word “结果”.
    const hasOutcome = /(?:最终|最后).{0,40}(?:完成|形成|实现|获得|提交|入选|获奖|提升|降低|改善|敲定)|结果(?:显示|表明|证明|为|是)|(?:成绩|获奖|评价|反馈|评委|老师).{0,20}(?:是|为|认为|肯定|认可)|(?:建议|方案|报告|定位|卖点).{0,20}(?:采纳|落地|提交|调整|形成)|(?:维持|精简|采用|搭配|放弃).{0,30}(?:定价|sku|模式|方案|结构|思路)/i.test(evidence)
    const hasReflection = /(?:意识到|认识到|学到|明白|反思|后来发现|这让我).{0,50}/.test(evidence)
    return {
      replyCount: evidenceReplies.length,
      hasContribution,
      hasChallenge,
      hasSolution,
      hasOutcome,
      hasReflection,
    }
  }
  const hasVerifiedExperienceCompletion = (experienceName: string) => {
    const queueItem = projectQueueItems.find(item => isLikelyExperienceAlias(item.name, experienceName))
    const queueProgress = queueItem ? getProjectQueueProgress(queueItem) : null
    if (queueProgress?.hasIdBoundQuestion) return queueProgress.complete
    const evidence = getExperienceEvidence(experienceName, queueItem?.id)
    if (!evidence) return false
    // A role description plus one generic follow-up is not a deep dive. Require
    // both process evidence and an outcome/reflection before the queue advances.
    return evidence.hasContribution &&
      (evidence.hasChallenge || evidence.hasSolution) &&
      (evidence.hasOutcome || evidence.hasReflection)
  }
  // Hidden EXP_DONE tags improve the UI, but they are not the only completion
  // source. Once a started experience has enough verified dialogue evidence, the
  // server may advance deterministically even if the model forgot the tag.
  const evidenceCompletedExperienceNames = Array.from(new Set([
    ...taggedExperienceNames,
    ...startedExperiences,
    ...(activeExperience ? [activeExperience] : []),
    ...projectQueueItems
      .filter(item => getProjectQueueProgress(item).complete)
      .map(item => item.name),
  ])).filter(name => hasVerifiedExperienceCompletion(name))
  const verifiedCompletedExperienceNames = Array.from(new Set([
    ...completedTaggedExperienceNames,
    ...completedExperiences,
    ...evidenceCompletedExperienceNames,
  ])).filter(name => cvText.trim() || hasVerifiedExperienceCompletion(name))
  const observedExperienceNames = Array.from(new Set([
    ...startedExperiences,
    ...completedExperiences,
    ...(activeExperience ? [activeExperience] : []),
    ...taggedExperienceNames,
    ...inferredInternshipNames,
    ...allDiscoveredProjectNames,
  ].map(normalizeName).filter(Boolean)))
  const observedInternshipNames = Array.from(new Set(messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return []
    const source = messageSource(message)
    const belongsToInternship = message.questionDimension === 'internship' ||
      /\[ASKING[：:]\s*internship\]/i.test(source)
    const opensInternship = /(?:第[一二两三四]|下一段|另一段|那段).{0,16}实习|实习.{0,24}(?:哪家公司|什么岗位|哪个单位|主要负责)/.test(source)
    if (!belongsToInternship || !opensInternship) return []
    const taggedName = source.match(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/i)?.[1]
    if (taggedName) return [normalizeName(taggedName)]
    const answer = messages.slice(index + 1).find(candidate => candidate.role === 'user')?.content.trim() || ''
    if (!answer || /^(?:没有|没|无)/.test(answer)) return []
    return [normalizeName(answer.split(/[。；;！!\n]/)[0].slice(0, 40))]
  }).filter(Boolean)))
  // Recover research/internship availability deterministically from the combined
  // pre-screen answer (for example “有一段实习，没有科研”). This state must not
  // depend on whether the model remembered to emit [EMPTY:].
  const effectiveEmptyDimensions = emptyDimensions.filter(dimension => ALL_DIMENSIONS.includes(dimension))
  let announcedInternshipCount = 0
  if (!cvText.trim()) {
    const availability = extractPreScreenAvailability(messages)
    for (const dimension of ['research', 'internship'] as const) {
      if (availability[dimension] === 'no' && !effectiveEmptyDimensions.includes(dimension)) {
        effectiveEmptyDimensions.push(dimension)
      } else if (availability[dimension] === 'yes') {
        const emptyIndex = effectiveEmptyDimensions.indexOf(dimension)
        if (emptyIndex >= 0) effectiveEmptyDimensions.splice(emptyIndex, 1)
      }
    }

    // If the applicant announced multiple internships, do not accept a premature
    // dimension-level COVERED marker until that many distinct experiences have
    // actually been opened. “有两段实习” must lead to two separate deep dives.
    const preScreenQuestionIndex = messages.findIndex(message =>
      message.role === 'assistant' && /[？?]/.test(messageSource(message)) &&
      /实习/.test(messageSource(message)) && /科研|研究|实验室|课题/.test(messageSource(message)))
    const preScreenAnswer = preScreenQuestionIndex >= 0
      ? messages.slice(preScreenQuestionIndex + 1).find(message => message.role === 'user')?.content || ''
      : ''
    const countToken = preScreenAnswer.match(/([一二两三四1-4])\s*段[^，,。；;]{0,12}实习/)?.[1]
    const countMap: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4 }
    announcedInternshipCount = countToken ? (countMap[countToken] ?? Number(countToken)) : 0
    if (announcedInternshipCount > 0 && observedInternshipNames.length < announcedInternshipCount) {
      effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'internship')
    }
  }
  const hasAnsweredQuestion = (pattern: RegExp) => {
    const questionIndex = messages.findIndex(message =>
      message.role === 'assistant' && pattern.test(messageSource(message))
    )
    return questionIndex >= 0 && (
      skippedQuestionIdSet.has(messages[questionIndex].id || '') ||
      messages.slice(questionIndex + 1)
        .some(message => message.role === 'user' && message.content.trim().length > 0)
    )
  }
  const hasAnsweredObjective = (objective: string, fallbackPattern: RegExp) => {
    const questionIndex = messages.findIndex(message =>
      message.role === 'assistant' &&
      (message.questionObjective === objective || fallbackPattern.test(messageSource(message))))
    return questionIndex >= 0 && (
      skippedQuestionIdSet.has(messages[questionIndex].id || '') ||
      messages.slice(questionIndex + 1)
        .some(message => message.role === 'user' && message.content.trim().length > 0)
    )
  }
  const hasFilledTargetPreference = Boolean(quickInfo?.targetSchool?.trim())
  const alternativeTargetAnswered = hasAnsweredObjective(
    'alternative_target',
    /(?:还有|其他|另外).{0,20}(?:心仪|想去|考虑).{0,16}(?:学校|院校|地区)|除了.{0,20}(?:学校|院校|地区).{0,20}(?:还有|其他)/,
  )
  const experienceAvailabilityAnswered = hasAnsweredObjective(
    'experience_availability',
    /(?=[\s\S]*[？?])(?=[\s\S]*实习)(?=[\s\S]*(?:科研|研究|实验室|课题|论文))/,
  )
  const hasSubstantiveAnsweredQuestion = (pattern: RegExp) => {
    const questionIndex = messages.findIndex(message =>
      message.role === 'assistant' && pattern.test(messageSource(message))
    )
    return questionIndex >= 0 && messages.slice(questionIndex + 1)
      .some(message => message.role === 'user' && message.content.trim().length >= 20)
  }
  const hasNegativeAnswerToQuestion = (pattern: RegExp) => {
    const questionIndex = messages.reduce((found, message, index) =>
      message.role === 'assistant' && pattern.test(messageSource(message)) ? index : found, -1)
    if (questionIndex < 0) return false
    const reply = messages.slice(questionIndex + 1).find(message => message.role === 'user')
    return !!reply && /^(?:没有|没|无|没有特别|没什么|都没有|想不到|暂时没有|好像没有)[了呢啊。！!\s]*$/.test(reply.content.trim())
  }
  const CORE_COURSES_QUESTION = /哪些.{0,12}(?:核心|专业).{0,6}课|核心.{0,8}(?:课程|专业课)|列举.{0,8}(?:课程|专业课)/
  const FOCUS_COURSE_QUESTION = /(?:(?:哪一门|哪几门|哪门|有没有|哪些课|这些.{0,8}课程).{0,30}(?:投入|收获|印象深刻|感兴趣|兴趣|喜欢)|(?:感兴趣|印象深刻|收获较大).{0,16}(?:课程|课))/
  const COURSE_DEPTH_QUESTION = /(?:这门|这些)课.{0,40}(?:学到|理解|掌握|带来|收获|方法|内容|思维|能力)|(?:具体|主要).{0,16}(?:学了什么|理解了什么|掌握了什么|带来什么|收获是什么)|(?:知识|方法|技能|框架|思维方式|实际能力).{0,16}(?:掌握|收获|学到|带来|提升)|给了你哪些.{0,16}(?:方法|能力)|印象最深的.{0,10}(?:知识点|方法)/
  const latestUserMessageIndex = messages.reduce((found, message, index) =>
    message.role === 'user' ? index : found, -1)
  const answeredAssistant = latestUserMessageIndex > 0
    ? [...messages.slice(0, latestUserMessageIndex)].reverse().find(message => message.role === 'assistant')
    : undefined
  const latestAnswer = latestUserMessageIndex >= 0 ? messages[latestUserMessageIndex].content.trim() : ''
  // Explicit question objectives are the primary sub-state transition. Regexes
  // only recover old sessions whose messages predate objective metadata.
  const coreCoursesAnswered = hasAnsweredQuestion(CORE_COURSES_QUESTION) ||
    (answeredAssistant?.questionObjective === 'academic_core_courses' && latestAnswer.length > 0)
  const focusCourseAnswered = hasAnsweredQuestion(FOCUS_COURSE_QUESTION) ||
    (answeredAssistant?.questionObjective === 'academic_focus_courses' && latestAnswer.length > 0)
  const courseDepthAnswered = hasSubstantiveAnsweredQuestion(COURSE_DEPTH_QUESTION)
  const noFocusCourse = hasNegativeAnswerToQuestion(FOCUS_COURSE_QUESTION)
  const academicStageComplete = hasCompleteAcademicBackgroundEvidence(messages) ||
    (coreCoursesAnswered && focusCourseAnswered && noFocusCourse)
  const uncoveredFocusCourses = getUncoveredFocusCourses(messages)
  const academicIsInCurrentWindow = messages.some(message =>
    message.role === 'assistant' && /\[ASKING[：:]\s*academic\]/i.test(messageSource(message)))
  if (!cvText.trim() && effectiveCoveredDimensions.includes('academic') &&
      academicIsInCurrentWindow && !academicStageComplete) {
    effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'academic')
  }
  const EXTRACURRICULAR_PROJECT_QUESTION = /(?:课程|课堂)(?:之外|以外)|课外.{0,20}(?:项目|活动|竞赛|比赛|大赛|实践)|除了.{0,20}(?:课程|上课|大作业).{0,30}(?:竞赛|比赛|大赛|个人项目|活动|实践|社团)|(?:参加过|做过).{0,16}(?:竞赛|比赛|大赛|个人项目|实践)|(?:竞赛|比赛|大赛|个人项目).{0,20}(?:社团|学生组织|社会实践|公益活动)/
  const extracurricularStageAnswered = hasAnsweredQuestion(EXTRACURRICULAR_PROJECT_QUESTION)
  const SUPPLEMENTAL_PROJECT_INVENTORY_QUESTION = /(?:再|还|另外).{0,24}(?:补充|想到|找出|讲).{0,20}(?:经历|项目|实践|活动|课程作业|课程论文)|如果.{0,20}(?:再补|还要补).{0,16}(?:一段|经历|项目)/
  const supplementalProjectInventoryAnswered = hasAnsweredObjective(
    'project_supplemental_inventory',
    SUPPLEMENTAL_PROJECT_INVENTORY_QUESTION,
  )
  const PROJECT_INVENTORY_QUESTION = /(?:(?:有没有|是否有|参加过|做过|还有|另外|再补充|再想想|除此之外|除已谈内容外).{0,80}(?:项目|竞赛|比赛|大赛|模拟法庭|法律援助|课程项目|课程设计|课程论文|毕业设计|社会实践|志愿|公益|社团|学生组织|实践|活动)|(?:项目|竞赛|比赛|大赛|模拟法庭|法律援助|课程项目|课程设计|课程论文|毕业设计|社会实践|志愿|公益|社团|学生组织).{0,60}(?:有没有|是否有|列出|名称|大致内容))/
  const NEGATIVE_PROJECT_INVENTORY_REPLY = /^(?:没有|没|无|没有了|没了|也没有|都没有|想不到|暂时没有|好像没有|没有特别合适的|没有其他了|没有别的了)[了呢啊吧。！!\s]*$/
  // A short answer such as “没了” only exhausts discovery when it is the direct
  // reply to a server-identified project inventory question. Opening target-school
  // checks and research/internship pre-screening must never close this dimension.
  const projectDiscoveryDeclined = messages.some((message, index) => {
    if (message.role !== 'assistant') return false
    const source = messageSource(message)
    const belongsToProject = message.questionDimension === 'project' ||
      /\[ASKING[：:]\s*project\]/i.test(source)
    if (!belongsToProject) return false

    const isInventoryQuestion = ['project_inventory', 'project_supplemental_inventory']
      .includes(message.questionObjective || '') ||
      (!message.questionObjective && PROJECT_INVENTORY_QUESTION.test(source))
    if (!isInventoryQuestion) return false

    const explicitlyBoundReply = message.id
      ? messages.find(candidate =>
          candidate.role === 'user' && candidate.replyToMessageId === message.id)
      : undefined
    let adjacentReply: Message | undefined
    if (!explicitlyBoundReply) {
      for (let replyIndex = index + 1; replyIndex < messages.length; replyIndex += 1) {
        const candidate = messages[replyIndex]
        if (candidate.role === 'assistant') break
        if (candidate.role === 'user') {
          adjacentReply = candidate
          break
        }
      }
    }
    const reply = explicitlyBoundReply || adjacentReply
    return skippedQuestionIdSet.has(message.id || '') ||
      Boolean(reply && NEGATIVE_PROJECT_INVENTORY_REPLY.test(reply.content.trim()))
  })
  const projectIsInCurrentWindow = messages.some(message =>
    message.role === 'assistant' && /\[ASKING[：:]\s*project\]/i.test(messageSource(message)))
  // Queue position, not the spelling of a project name, controls progress.
  // Always select the first item whose own question-id evidence is incomplete.
  const pendingProjectQueueItems = projectQueueItems.filter(item => {
    const progress = getProjectQueueProgress(item)
    if (progress.hasIdBoundQuestion) return !progress.complete
    const legacyEvidence = getExperienceEvidence(item.name, item.id)
    return !legacyEvidence || !legacyEvidence.hasContribution ||
      (!legacyEvidence.hasChallenge && !legacyEvidence.hasSolution) ||
      (!legacyEvidence.hasOutcome && !legacyEvidence.hasReflection)
  })
  const pendingProjectCandidates = pendingProjectQueueItems.map(item => item.name)
  if (!cvText.trim() && effectiveCoveredDimensions.includes('project') && projectIsInCurrentWindow &&
      (!extracurricularStageAnswered || pendingProjectCandidates.length > 0)) {
    effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'project')
  }
  if (!cvText.trim() && projectDiscoveryDeclined && pendingProjectCandidates.length === 0 &&
      !effectiveCoveredDimensions.includes('project')) {
    effectiveCoveredDimensions.push('project')
  }
  // The first pass only interviews projects the applicant actually volunteered.
  // Once that queue is empty, project is complete regardless of a numeric target.
  if (!cvText.trim() && extracurricularStageAnswered && pendingProjectCandidates.length === 0 &&
      allDiscoveredProjectNames.length > 0 && !effectiveCoveredDimensions.includes('project')) {
    effectiveCoveredDimensions.push('project')
  }
  const MAJOR_MOTIVATION_QUESTION = /为什么.{0,24}(?:选择|申请|深耕|继续).{0,24}(?:专业|方向)|(?:专业|方向).{0,24}(?:吸引|兴趣|契机|为什么)|是什么让你.{0,16}(?:决定|想).{0,16}(?:继续读|申请|深耕|沿着.*方向)/
  const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const targetSchoolTokens = Array.from(new Set([
    quickInfo?.targetSchool?.trim() || '',
    (quickInfo?.targetSchool || '').replace(/(?:目标)?(?:院校|学校|大学|项目)/g, '').trim(),
  ].flatMap(value => value.split(/[、，,\/|]/)).filter(value => value.length >= 2)))
  const targetSchoolAlternation = targetSchoolTokens.map(escapePattern).join('|')
  const schoolSubject = targetSchoolAlternation
    ? `(?:学校|院校|项目|地区|国家|${targetSchoolAlternation})`
    : '(?:学校|院校|项目|地区|国家)'
  const SCHOOL_MOTIVATION_QUESTION = new RegExp(
    `为什么.{0,24}(?:选择|申请|想去).{0,24}${schoolSubject}|${schoolSubject}.{0,60}(?:吸引你.{0,12}是什么|为什么想|为什么选|原因|看中|契合|研究力量|培养资源)`,
    'i'
  )
  // New sessions carry an authoritative objective for each half of motivation.
  // Prefer it over wording regexes, which are intentionally only a compatibility
  // fallback for older transcripts and cannot enumerate every natural phrasing.
  const majorMotivationAnswered = hasAnsweredObjective('motivation_major', MAJOR_MOTIVATION_QUESTION)
  const schoolMotivationAnswered = hasAnsweredObjective('motivation_school', SCHOOL_MOTIVATION_QUESTION)
  const motivationAnswered = majorMotivationAnswered || schoolMotivationAnswered
  const motivationIsInCurrentWindow = messages.some(message =>
    message.role === 'assistant' && /\[ASKING[：:]\s*motivation\]/i.test(messageSource(message)))
  if (!cvText.trim() && effectiveCoveredDimensions.includes('motivation') && motivationIsInCurrentWindow &&
      !motivationAnswered) {
    effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'motivation')
  }

  const planAnsweredFromHistory = hasSubstantiveAnsweredQuestion(/\[ASKING[：:]\s*plan\]/i) ||
    hasSubstantiveAnsweredQuestion(/(?:毕业后|读完.{0,10}(?:硕士|博士|项目)|职业.{0,8}(?:方向|规划)|未来.{0,8}(?:方向|规划)).*[？?]/i)
  // Client state and model tags are hints, not authority. A dimension cannot be
  // carried forward as complete without its dedicated question and answer.
  if (!cvText.trim() && !planAnsweredFromHistory) {
    effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'plan')
  }

  // Promote dimensions from deterministic conversation evidence when the model
  // omitted [COVERED:]. These checks describe completed question contracts, not
  // loose keyword mentions.
  if (!cvText.trim()) {
    if (academicStageComplete && !effectiveCoveredDimensions.includes('academic')) {
      effectiveCoveredDimensions.push('academic')
    }
    if (motivationAnswered &&
        !effectiveCoveredDimensions.includes('motivation')) {
      effectiveCoveredDimensions.push('motivation')
    }
    for (const dimension of ['plan']) {
      const marker = new RegExp(`\\[ASKING[：:]\\s*${dimension}\\]`, 'i')
      const answered = hasSubstantiveAnsweredQuestion(marker)
      if (answered && !effectiveCoveredDimensions.includes(dimension)) {
        effectiveCoveredDimensions.push(dimension)
      }
    }

  }

  // Starting a deep dive is not completing it. Do not recover an entire research
  // or internship dimension from a single substantive answer. Every announced
  // experience must have its own EXP_DONE event before the queue can advance.
  if (!cvText.trim()) {
    for (const dimension of ['research', 'internship']) {
      const completedInDimension = Array.from(new Set(completedTaggedExperienceNames
        .map(normalizeName)
        .filter(name => experienceDimensionByName.get(name) === dimension)))
      const requiredCount = dimension === 'internship'
        ? Math.max(announcedInternshipCount, 1)
        : 1
      const everyExperienceCompleted = completedInDimension.length >= requiredCount

      if (!everyExperienceCompleted) {
        effectiveCoveredDimensions = effectiveCoveredDimensions.filter(value => value !== dimension)
      } else if (!effectiveCoveredDimensions.includes(dimension)) {
        effectiveCoveredDimensions.push(dimension)
      }
    }
    if (announcedInternshipCount > 0 && observedInternshipNames.length < announcedInternshipCount) {
      effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'internship')
    }
  }

  // Never trust a non-contiguous no-CV completion set.  Later dimensions may be
  // discussed incidentally, but they become complete only after every earlier
  // dimension has been completed, confirmed empty, or explicitly deferred.
  if (!cvText.trim()) {
    const accepted: string[] = []
    const resolved = new Set([...effectiveEmptyDimensions, ...deferredDimensions])
    const candidates = new Set(effectiveCoveredDimensions)
    for (const dimension of ALL_DIMENSIONS) {
      if (resolved.has(dimension)) continue
      if (!candidates.has(dimension)) break
      accepted.push(dimension)
      resolved.add(dimension)
    }
    effectiveCoveredDimensions = accepted
  }

  const hasDimensionDepth = (dimension: string, minimumUserReplies: number) => {
    const askingIndex = messages.findIndex(message =>
      message.role === 'assistant' &&
      new RegExp(`\\[ASKING[：:]\\s*${dimension}\\]`, 'i').test(messageSource(message))
    )
    if (askingIndex < 0) return false
    return messages.slice(askingIndex + 1)
      .filter(message => message.role === 'user' && message.content.trim().length >= 20)
      .length >= minimumUserReplies
  }
  const priorExperienceDimensionReady = (dimension: 'academic' | 'research' | 'internship') =>
    (dimension === 'academic' && academicStageComplete) ||
    effectiveCoveredDimensions.includes(dimension) || effectiveEmptyDimensions.includes(dimension)
  const readyToEnterProject = !cvText.trim() && !extracurricularStageAnswered &&
    priorExperienceDimensionReady('academic') &&
    priorExperienceDimensionReady('research') &&
    priorExperienceDimensionReady('internship')

  // Experience priority policy: exhaust formal research and internships first,
  // then use the project dimension to build toward three distinct useful stories.
  const isRoutineCoursePractice = (name: string) =>
    /课程实操|课程实验|实验实操|上机实验|实验练习|仪器实操/.test(name) &&
    !/项目|设计|竞赛|比赛|大赛|论文|报告|调研/.test(name)
  // An experience counts only after its deep-dive arc has closed. An explicit
  // low rating excludes it; otherwise a completed, correctly classified story
  // remains countable even if the model omitted optional value metadata.
  const completedCandidates = Array.from(new Set([
    ...verifiedCompletedExperienceNames,
  ].map(normalizeName).filter(Boolean)))
  const retractedExperienceNames = new Set(messages.flatMap(message =>
    (message.progressEvents ?? [])
      .filter(event => event.type === 'experience_retracted' && event.experience)
      .map(event => normalizeName(event.experience || ''))
  ).filter(Boolean))
  const inferredProjectNameSet = new Set(allDiscoveredProjectNames.map(normalizeName))
  const eligibleExperienceNames = completedCandidates.filter(name => {
    if (retractedExperienceNames.has(name)) return false
    const value = experienceValueByName.get(name)
    const dimension = experienceDimensionByName.get(name)
    return ['research', 'internship', 'project'].includes(dimension || '') &&
      (dimension !== 'project' || qualifiedProjectExperienceNames.has(name) || inferredProjectNameSet.has(name)) &&
      !isRoutineCoursePractice(name) && value !== 'low'
  })
  // The applicant's pre-screen answer and separately opened internship carriers
  // are the identity boundary. Model-generated aliases for a task inside the same
  // internship must not inflate the three-experience count.
  const internshipLimit = Math.max(announcedInternshipCount, observedInternshipNames.length)
  let acceptedInternships = 0
  const distinctExperienceNames = eligibleExperienceNames.filter(name => {
    if (experienceDimensionByName.get(name) !== 'internship' || internshipLimit === 0) return true
    if (acceptedInternships >= internshipLimit) return false
    acceptedInternships += 1
    return true
  })
  // Collapse model-generated aliases for the same experience. Exact string
  // equality is insufficient (“环境资源法课程论文” vs “基层环保裁量课程论文”).
  const canonicalExperienceNames: string[] = []
  for (const name of distinctExperienceNames) {
    if (!canonicalExperienceNames.some(existing => isLikelyExperienceAlias(existing, name))) {
      canonicalExperienceNames.push(name)
    }
  }
  const concreteExperienceCount = canonicalExperienceNames.length

  // Aim for three useful stories, but allow only one supplemental inventory
  // question. A negative or non-productive answer exhausts discovery and must
  // never trap the applicant in the project dimension.
  const latestUserAnswer = [...messages].reverse().find(message => message.role === 'user')?.content.trim() || ''
  const onlyConfirmedProjectAvailability = /^(?:我)?有(?:过)?(?:一|二|两|三|四|几|多)?段?(?:相关的?)?(?:竞赛|比赛|大赛|个人项目|开源项目|项目|实践)(?:经历)?[了呢啊吧。！!\s]*$/.test(latestUserAnswer)
  const shouldAskSupplementalProjectInventory = !cvText.trim() &&
    extracurricularStageAnswered && pendingProjectCandidates.length === 0 &&
    concreteExperienceCount < 3 && !supplementalProjectInventoryAnswered &&
    !projectDiscoveryDeclined
  const supplementalAnswerNeedsIdentity = !cvText.trim() &&
    supplementalProjectInventoryAnswered && onlyConfirmedProjectAvailability &&
    pendingProjectCandidates.length === 0
  if (shouldAskSupplementalProjectInventory || supplementalAnswerNeedsIdentity) {
    effectiveCoveredDimensions = effectiveCoveredDimensions.filter(dimension => dimension !== 'project')
  } else if (!cvText.trim() && supplementalProjectInventoryAnswered &&
      pendingProjectCandidates.length === 0 && !effectiveCoveredDimensions.includes('project')) {
    // The single extra discovery opportunity has been consumed. Even if the
    // answer yields no countable story, accept the real inventory and move on.
    effectiveCoveredDimensions.push('project')
  }

  // Exclude covered, deferred, and empty from the normal list
  const missing = ALL_DIMENSIONS.filter(
    d => !effectiveCoveredDimensions.includes(d) && !deferredDimensions.includes(d) && !effectiveEmptyDimensions.includes(d)
  )

  // Revisit any legacy deferred dimension after the normal six-dimension pass.
  const uncoveredDeferred = deferredDimensions.filter(d =>
    ALL_DIMENSIONS.includes(d) && !effectiveCoveredDimensions.includes(d))
  if (uncoveredDeferred.length > 0) {
    missing.push(...uncoveredDeferred.filter(d => !missing.includes(d)))
  }

  // This is the authoritative dimension for the response being generated. The
  // client reads it before the first text chunk, so the sidebar and the streamed
  // question advance together instead of reverse-engineering progress from prose.
  const authoritativeDimension = !cvText.trim()
    ? (missing[0] || '')
    : ''

  // Convert structured cvAnalysis into natural prompt text
  let cvAnalysisForPrompt = ''
  if (cvAnalysis.trim()) {
    const entries: { name: string; type: string; reason: string }[] = []
    let cur: { name: string; type: string; reason: string } | null = null
    for (const raw of cvAnalysis.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      if (/^经历名称[：:]/.test(line)) {
        if (cur) entries.push(cur)
        cur = { name: line.replace(/^经历名称[：:]/, '').trim(), type: '', reason: '' }
      } else if (/^经历类型[：:]/.test(line) && cur) {
        cur.type = line.replace(/^经历类型[：:]/, '').trim()
      } else if (/^深挖原因[：:]/.test(line) && cur) {
        cur.reason = line.replace(/^深挖原因[：:]/, '').trim()
      } else if (cur && cur.reason) {
        cur.reason += ' ' + line
      }
    }
    if (cur) entries.push(cur)
    if (entries.length > 0) {
      cvAnalysisForPrompt = entries
        .map((e, i) => `${i + 1}. 【${e.name}】${e.type ? `（${e.type}）` : ''}：${e.reason}`)
        .join('\n')
    } else {
      cvAnalysisForPrompt = cvAnalysis.trim()
    }
  }

  // The state machine chooses only the next conversational objective. The AI
  // still writes the actual response from the full dialogue context, so tone,
  // acknowledgement and wording remain natural rather than template-driven.
  let turnDirective = ''
  let turnObjective = ''
  let turnSubject = ''
  let turnSubjectId = ''
  const completedExperienceSet = new Set([
    ...verifiedCompletedExperienceNames,
  ].map(normalizeName))
  const pendingProjectQueueItem = pendingProjectQueueItems[0]
  // The first incomplete queue id is authoritative. activeExperience and model
  // EXP tags are legacy display hints and can never reorder this queue.
  const pendingDiscoveredProject = pendingProjectQueueItem?.name ||
    allDiscoveredProjectNames.find(name => !completedExperienceSet.has(normalizeName(name))) || ''
  const startedExperienceSet = new Set(startedExperiences.map(normalizeName))
  const targetMajorForRanking = quickInfo?.targetMajor?.trim() || quickInfo?.major?.trim() || '目标专业'
  const applicantDisciplineText = `${quickInfo?.major || ''} ${quickInfo?.targetMajor || ''}`
  const isLawApplicant = /法学|法律|law\b|llm\b/i.test(applicantDisciplineText)
  const isBusinessApplicant = /工商|管理|市场|营销|金融|会计|经济|商科|business|marketing|finance|economics/i.test(applicantDisciplineText)
  const isTechnicalApplicant = /计算机|软件|数据|人工智能|电子|电气|工程|机械|材料|物理|化学|生物|computer|engineering|science/i.test(applicantDisciplineText)
  const academicRecallGuide = isLawApplicant
    ? '可以从一个印象较深的制度、案例或争议说起，再说它后来提醒你看法律问题时多注意什么'
    : isBusinessApplicant
      ? '可以从一个模型、指标或商业案例说起，再说它后来怎样影响你观察企业或市场'
      : isTechnicalApplicant
        ? '可以从一个原理、方法、实验或设计取舍说起，再说它后来怎样影响你解决问题'
        : '可以从一个印象较深的概念、案例或任务说起，再说它后来怎样影响你理解专业问题'
  const projectInventoryQuestion = isLawApplicant
    ? '除了正式实习和科研之外，你参加过模拟法庭、法律援助、法学竞赛、辩论、社会调研或其他法治实践吗？如果有，先简单列出名称就好。'
    : '课程之外，你参加过哪些与申请方向相关的竞赛、实践或自主完成的项目？如果有，先简单列出名称和大致内容就好。'
  const hasUserConfirmedApplicationSpecialization = messages.some(message =>
    message.role === 'user' && /(?:申请|目标(?:专业|项目|方向)|打算申请).{0,30}[\u4e00-\u9fa5A-Za-z]{2,12}方向/.test(message.content)
  )
  if (!cvText.trim() && hasFilledTargetPreference && !alternativeTargetAnswered) {
    turnObjective = 'alternative_target'
    turnDirective = `申请者已经填写目标院校或地区“${quickInfo?.targetSchool || ''}”。先用一句话自然确认，然后只浅问：除此之外是否还有其他心仪院校、特别想去的学校或地区？不要追问原因，不要进入申请动机、学术背景或经历。`
  } else if (!cvText.trim() && !experienceAvailabilityAnswered) {
    turnObjective = 'experience_availability'
    turnDirective = '进行正式采访前的快速预筛。只询问申请者是否有与目标方向相关的正式实习，以及是否加入实验室/课题组持续科研或发表投稿过论文。只需回答有或没有，不展开深挖。'
  } else if (!cvText.trim() && missing[0] === 'academic' && !coreCoursesAnswered) {
    turnObjective = 'academic_core_courses'
    turnDirective = '正式进入学术背景。本轮只让申请者列出专业核心课程，不要同时询问最喜欢、最投入、收获最大或印象最深的课程，也不要询问课程内容或项目。'
  } else if (!cvText.trim() && missing[0] === 'academic' && coreCoursesAnswered && !focusCourseAnswered) {
    turnObjective = 'academic_focus_courses'
    turnDirective = '继续学术背景。只询问刚才列出的课程中有哪些比较感兴趣、投入较多、收获较大或印象深刻；允许多门，不要同时追问具体内容、方法或项目。'
  } else if (!cvText.trim() && missing[0] === 'academic' && uncoveredFocusCourses.length > 0) {
    turnSubject = uncoveredFocusCourses[0]
    const courseGap = getAcademicCourseGap(messages, turnSubject)
    const hasLegacyCourseSplit = messages.some(message =>
      message.questionSubject === turnSubject &&
      ['academic_course_content', 'academic_course_takeaway'].includes(message.questionObjective || ''))
    turnObjective = hasLegacyCourseSplit
      ? (courseGap === 'content' ? 'academic_course_content' : 'academic_course_takeaway')
      : 'academic_course_profile'
    turnDirective = turnObjective === 'academic_course_profile'
      ? `继续学术背景。本轮只围绕“${turnSubject}”提出一个容易回答的综合问题。先问这门课里哪个具体内容最影响申请者后来理解或处理专业问题，并在问号之后附一句简短的非问题式提示：“${academicRecallGuide}。”提示只提供回忆路径，绝不能给出该课程可能对应的专业结论或标准答案。只出现一个问号，不拆成“学了什么”和“有什么收获”两个并列问题，不要求标准术语。若此前已聊过另一门重点课，用半句话自然承接；不要使用“我们先聊某某吧”重新开场。不得询问课程项目、实习或科研。末尾输出 [ASKING:academic]。`
      : turnObjective === 'academic_course_content'
        ? `继续学术背景。本轮只围绕“${turnSubject}”询问课程主要学习内容。若此前已聊过另一门重点课，先用半句话自然转接，不要使用“我们先聊某某吧”重新开场。不要同时询问收获、能力、项目或实验细节。不得切换到实习、科研或项目。`
        : `继续学术背景。本轮只围绕“${turnSubject}”补充尚未出现的个人分析方式。先检查用户刚才是否已经主动说出平衡、判断、边界、尺度、方法或视角；已经说出的观点不得换成“带来什么新方法/新视角”再问一遍。优先把问题落到“现在遇到具体法律问题时会多看哪一层”，或与此前重点课程形成自然联系，不使用抽象问卷句式。不要再重复课程内容，也不要询问项目或实验细节。不得切换到实习、科研或项目。`
  } else if (!cvText.trim() && missing[0] === 'academic' && coreCoursesAnswered && !courseDepthAnswered) {
    turnDirective = focusCourseAnswered
      ? '继续学术背景。自然回应用户主动提到的感兴趣或印象深刻的课程，追问这些课程带来的核心知识、分析方法、思维方式或实际能力；一次只问一个核心问题，不强迫用户选定唯一一门课程。末尾输出 [ASKING:academic]。'
      : '继续学术背景。自然回应用户列出的核心课程，开放地询问其中有没有感兴趣、投入较多、收获较大或印象深刻的课程；允许用户说一门、多门或没有，不要求选出唯一代表课程，暂时不要问课程项目。末尾输出 [ASKING:academic]。'
  } else if (!cvText.trim() && onlyConfirmedProjectAvailability &&
      (missing[0] === 'project' || missing[0] === 'needs_more_experiences' || authoritativeDimension === 'project')) {
    turnObjective = 'project_identify_experience'
    turnDirective = `自然回应申请者确实有这类经历，然后用一个开放问题请其简单介绍这段经历是什么；不要拆成“名称、赛制、案件类型、团队、角色”等多个并列小问。不要把“有一段竞赛经历”当成项目名称，也不要在尚不知道项目是什么时直接问最大困难、收获或结果。末尾输出 [ASKING:project]。`
  } else if (!cvText.trim() && pendingDiscoveredProject &&
      (missing[0] === 'project' || missing[0] === 'needs_more_experiences' || authoritativeDimension === 'project')) {
    turnSubject = pendingDiscoveredProject
    turnSubjectId = pendingProjectQueueItem?.id || ''
    const projectHasStarted = Boolean(
      (turnSubjectId && messages.some(message => message.questionSubjectId === turnSubjectId)) ||
      startedExperienceSet.has(normalizeName(pendingDiscoveredProject)),
    )
    const queueProgress = pendingProjectQueueItem
      ? getProjectQueueProgress(pendingProjectQueueItem)
      : null
    const projectEvidence = getExperienceEvidence(pendingDiscoveredProject, turnSubjectId)
    const contributionAnswered = queueProgress?.hasIdBoundQuestion
      ? queueProgress.contributionAnswered
      : projectEvidence?.hasContribution
    const processAnswered = queueProgress?.hasIdBoundQuestion
      ? queueProgress.processAnswered
      : Boolean(projectEvidence?.hasChallenge || projectEvidence?.hasSolution)
    if (!projectHasStarted || !contributionAnswered) {
      turnObjective = 'project_open_experience'
      turnDirective = `用户已经提供了项目候选“${pendingDiscoveredProject}”。本轮正式打开这一段，只询问申请者在其中主要负责或亲自完成了哪一部分；不要同时询问题目、团队分工、困难、解决方法、结果或收获。首次深挖需用该项目的准确简称输出 [EXP:经历简称] 和 [ASKING:project]。`
    } else if (!processAnswered) {
      turnObjective = 'project_deep_dive_process'
      turnDirective = `继续深挖当前项目“${pendingDiscoveredProject}”。用户已经说明了个人职责，本轮只开放询问实际遇到的一个困难、关键判断或重要取舍，以及当时如何处理；不得虚构缺失值、样本问题或其他具体困难作为提问前提，不得询问结果、收获或另一段经历。末尾输出 [ASKING:project]。`
    } else {
      turnObjective = 'project_deep_dive_outcome'
      turnDirective = `继续深挖当前项目“${pendingDiscoveredProject}”。用户已经说明个人职责和处理过程，本轮只询问最终产出、可验证结果、外部反馈或个人反思中最适合该经历的一项；不得把尚未出现的成绩、奖项、落地效果写成事实，不得寻找另一段经历。末尾输出 [ASKING:project]。`
    }
  } else if (!cvText.trim() && missing[0] === 'project' && shouldAskSupplementalProjectInventory) {
    turnObjective = 'project_supplemental_inventory'
    turnDirective = isLawApplicant
      ? `当前只有 ${concreteExperienceCount} 段有效经历。只再补问一次：除已谈内容外，课程论文、课程研究、模拟法庭、法律援助、法学竞赛、社会调研或学生组织中，是否还有一段能体现申请者实际投入和产出的经历？有则只请其说名称与大致内容；没有也可以明确回答没有。不得拆成多轮分类追问。末尾输出 [ASKING:project]。`
      : `当前只有 ${concreteExperienceCount} 段有效经历。只再补问一次：除已谈内容外，课程项目、竞赛、实践、学生组织或自主项目中，是否还有一段能体现申请者实际投入和产出的经历？有则只请其说名称与大致内容；没有也可以明确回答没有。不得拆成多轮分类追问。末尾输出 [ASKING:project]。`
  } else if (!cvText.trim() &&
      (missing[0] === 'project' || readyToEnterProject) && !extracurricularStageAnswered) {
    turnObjective = 'project_inventory'
    turnDirective = `先自然回应申请者刚才关于课程内容、方法或收获的回答，用一句具体但克制的承接完成学术背景转场；不要使用“更有区分度”“高价值候选”“含金量排序”等内部评估措辞。随后使用符合申请专业的经历载体进行盘点，本轮问题采用这个方向：“${projectInventoryQuestion}”不得出现明显属于其他学科的示例。收到清单后，你在内部结合申请方向“${targetMajorForRanking}”，按专业相关性、任务复杂度、个人贡献、可验证成果和动机价值排序，不能把排序过程说给用户。暂时不要询问课程作业。末尾输出 [ASKING:project]。`
  } else if (!cvText.trim() && missing[0] === 'motivation' && !majorMotivationAnswered) {
    turnObjective = 'motivation_major'
    turnDirective = '进入申请动机。结合用户已经讲过的经历，用一次自然提问邀请其说明两方面：是什么让其决定继续申请当前专业/方向，以及为什么选择目前的目标院校或地区。两方面最好都问到，但用户只回答其中一方面也不阻塞后续。不要询问未来规划。末尾输出 [ASKING:motivation]。'
  } else if (!cvText.trim() && missing[0] === 'motivation' && majorMotivationAnswered && !schoolMotivationAnswered) {
    turnObjective = 'motivation_school'
    turnDirective = '继续申请动机。先自然回应已表达的专业动机，再开放询问申请者实际了解过目标院校或地区的哪些具体资源、培养特点或实践环境，以及这些内容为何适合其方向。不得在问题中主动罗列课程、教师、研究平台等候选答案，不得把未经用户确认的院校信息写成事实。不要询问未来规划。末尾输出 [ASKING:motivation]。'
  }

  // One-shot academic objectives may never be issued twice after a reply. This
  // is an enforcement boundary independent of wording classifiers.
  if (answeredAssistant?.questionObjective === turnObjective && latestAnswer &&
      turnObjective === 'academic_course_profile') {
    turnObjective = 'academic_course_profile_clarification'
    turnDirective = `申请者已经回应过“${turnSubject}”的综合课程问题，但信息很简短或表示不知道怎样组织。不得原样重复上一问；只进行一次脚手架式引导。使用这个回忆路径：“${academicRecallGuide}。”把它改写成一个具体、容易回答的问题，但不得提供专业结论、虚构案例或候选答案。无论这次回答长短，下一轮都结束该课程。末尾输出 [ASKING:academic]。`
  } else if (answeredAssistant?.questionObjective === turnObjective && latestAnswer &&
      turnObjective === 'academic_focus_courses') {
    const recoveredCourse = latestAnswer
      .split(/[、，,；;]|和|以及|与/)[0]
      .replace(/[。！!？?].*$/, '')
      .replace(/(?:吧|呢|啊|呀|嘛|啦)$/u, '')
      .trim()
    if (recoveredCourse) {
      turnSubject = recoveredCourse
      turnObjective = 'academic_course_content'
      turnDirective = `申请者已经选定重点课程“${recoveredCourse}”。不得再次询问选择哪门课；本轮只自然询问这门课主要学习了哪些内容。末尾输出 [ASKING:academic]。`
    }
  }
  if (controlAction === 'rephrase' && controlTargetQuestion) {
    turnObjective = controlTargetQuestion.questionObjective || turnObjective
    turnSubject = controlTargetQuestion.questionSubject || turnSubject
    turnSubjectId = controlTargetQuestion.questionSubjectId || turnSubjectId
    const originalQuestion = controlTargetQuestion.content.trim().slice(0, 240)
    turnDirective = `申请者点击了“换个方式问”，这不是采访答案，也没有提供任何新事实。保持原来的维度、经历和阶段不变，用更短、更具体、更容易回忆的方式重新提出同一个核心问题。不得引用或复述“这个问题我不太清楚怎么回答”等界面提示；不得声称用户重复粘贴、输入有误或已经回答；不得进入下一阶段或创建新经历。原问题是：“${originalQuestion}”。`
  } else if (controlAction === 'skip' && controlTargetQuestion) {
    turnDirective = `${turnDirective}\n申请者通过界面明确跳过了上一问题；这不是采访内容，不得引用为用户事实。按照状态机当前选择的下一缺口继续，不得换措辞重问被跳过的问题。`.trim()
  }
  const isPreludeObjective = ['alternative_target', 'experience_availability'].includes(turnObjective)

  let systemPrompt = buildInterviewSystemPrompt(
    missing, cvText, cvAnalysisForPrompt, quickInfo, activeExperience, completedExperiences
  )
  if (turnDirective) {
    systemPrompt += isPreludeObjective
      ? `\n\n## 【本轮开场步骤】\n${turnDirective}\n请自然、简洁地完成这个步骤，不展开深挖。`
      : `\n\n## 【本轮采访任务】\n${turnDirective}\n结合完整对话自然承接。本轮只完成这一项任务，只围绕一个核心信息缺口提问；即使用户刚才已部分回答，也不得在同一回复中提前开启下一个维度。`
  }
  if (authoritativeDimension && !isPreludeObjective) {
    systemPrompt += `\n\n## 【本轮唯一维度——硬约束】\n状态机已确定本轮维度为 ${authoritativeDimension}。本轮所有问题都必须属于该维度，只能围绕一个核心信息缺口；不得询问、预告式询问或顺带拼接任何其他维度的问题。可以自然回应用户上一轮内容，但回应不能带出新的跨维度问题。回复末尾输出 [ASKING:${authoritativeDimension}]，不得自行改成其他维度。只有收到下一轮服务器状态后，才允许切换维度。`
  }
  systemPrompt += `\n\n## 【本轮表达质量——硬约束】\n承接最多一句，只复述已确认事实；随后直接提出一个自然问题。禁止使用“顶尖、稀缺、特别能打动招生官、很多执业者才具备”等未经证据支持的评价，禁止替申请者宣布其已经具备某项能力或动机。不得使用“都聊透了、非常完整、十分成熟、很难得”等绝对化收束；改用“基本聊清楚”或直接自然转场。一条回复最多出现一个问号，不得用第二个问句追加核实。完整回复原则上不超过 120 个汉字（隐藏标记不计），确有必要解释误解时除外。学校、专业及机构名称必须逐字沿用对话或基本信息，不能自行替换简称。引用用户口语中的课程或经历名称时，去掉句末的“吧、呢、啊、呀”等语气词。若最新用户消息明显复制了助理上一条回复，不把其中内容视为用户证据，只简短说明似乎重复粘贴并重新提出原问题。`
  systemPrompt += `\n\n## 【目标专业事实锁】\n申请者填写的目标专业原文是“${quickInfo?.targetMajor?.trim() || '尚未明确'}”。喜欢某门课程、某个研究主题或在回答中提到细分领域，都不等于已经选择该申请方向。除非申请者此前主动明确说“申请/目标是某某方向”，否则只能称其申请“${quickInfo?.targetMajor?.trim() || '当前目标专业'}”，不得自行改称经济法、行政法、环境法等细分方向；如细分方向对后续采访必要，先用一个确认问题核实。`
  if (authoritativeDimension === 'motivation') {
    systemPrompt += `\n\n## 【申请动机顺序锁】\n当前只采访“为什么申请”：尽量在一次自然提问中覆盖专业/方向兴趣来源与具体学校/地区的选择原因。申请者回答任一方面后即可完成本维度；两方面都获得回答是建议目标，不是推进门槛。用户用某段经历解释动机后，不得重新追问该经历的困难、行动、解决或结果。询问院校契合时必须让用户先说其实际查过的具体资源，不得在问题中提供课程、教师、研究平台或当地制度等标准答案。严禁询问毕业后做什么、就业还是读博、五年或十年后的方向；这些属于未来规划。`
  }
  if (authoritativeDimension === 'plan') {
    systemPrompt += `\n\n## 【未来规划顺序锁】\n只有状态机已完成申请动机后才会进入本维度。本轮只询问毕业后的职业或学术发展规划，不得回头补问学校选择原因或专业申请原因。首次提问优先问毕业后的第一步或短期落点，不要固定从“五年后”开始；短期方向已经明确时才按需追问三至五年的长期目标。`
  }
  if (['research', 'internship', 'project'].includes(authoritativeDimension)) {
    systemPrompt += `\n\n## 【单经历提问边界】\n本轮只围绕一段具体经历追问一个核心主题。先检查申请者已经主动提供的内容，只补最关键的真实缺口；不得把“角色、行动、挑战、解决、结果、反思”机械拆成轮轮必问。若本轮仍向当前经历提出问题，绝不能同时说“已经聊充分/聊到这里”，也不能预告、点名或询问下一段经历；完成判断只能等申请者回答后发生。若已取得基本事实和个人贡献，并取得困难处理或结果反思中的至少一类信息，即可收束；用户明确表示没有后续案例或不记得时不得改用假设题追问同一结论。法律援助须确认组织或带教边界并尽量取得个案后续；课程论文须确认完成形式、材料范围或教师反馈中的至少一项；模拟法庭须取得比赛层级、个人角色以及成绩或反馈。切换后本轮问题只针对新经历。`
  }
  if (!cvText.trim()) {
    const emptyResearchAndInternship = effectiveEmptyDimensions.includes('research') && effectiveEmptyDimensions.includes('internship')
    const targetDescription = emptyResearchAndInternship
      ? '科研和实习均为空，需要优先从项目维度寻找有效素材'
      : '科研、实习和项目共同构成有效经历库存'
    const countedNames = canonicalExperienceNames.length > 0
      ? canonicalExperienceNames.map((name, index) => `${index + 1}. ${name}`).join('\n')
      : '（暂无）'
    systemPrompt += `\n\n## 【三段有效经历目标】\n${targetDescription}。当前已完成的有效经历为 ${concreteExperienceCount} 段：\n${countedNames}\n进入申请动机前优先收集 3 段有效经历。科研、实习和首次项目清单处理完后若仍不足 3 段，只允许再进行一次综合补充盘点；用户明确没有，或该次补充仍不足 3 段，都必须接受真实库存并进入申请动机。严禁继续换类别、换措辞或拆成课程作业、学生组织、志愿活动等多轮追问。不得把同一经历换标题重复计数。`

    const resolvedUnavailable = (['research', 'internship'] as const)
      .filter(dimension => effectiveEmptyDimensions.includes(dimension))
      .map(dimension => dimension === 'research' ? '科研' : '实习')
    if (resolvedUnavailable.length > 0) {
      systemPrompt += `\n\n## 【已确认无对应经历——禁止回问】\n申请者已经明确确认没有${resolvedUnavailable.join('和')}经历。此事实已经记录，不得在项目盘点、项目收尾或维度切换时再次询问是否有这些经历，也不得把它们与新问题捆绑复核。只按当前状态机任务继续。`
    }
  }
  if (!cvText.trim() && missing[0] === 'project') {
    if (pendingProjectCandidates.length > 0) {
      systemPrompt += `\n\n## 【服务器项目队列——必须按序完成】\n以下是申请者已经明确列出的待采访经历：\n${pendingProjectCandidates.map((name, index) => `${index + 1}. ${name}`).join('\n')}\n只采访队首“${pendingDiscoveredProject || pendingProjectCandidates[0]}”。队列清空前严禁询问课程作业、学生组织或其他新经历；不得丢弃后续条目。`
    }
    if (!extracurricularStageAnswered) {
      systemPrompt += `\n\n## 【项目覆盖提醒】\n先取得课程外项目清单。申请者一次声明多段时，结合申请方向“${targetMajorForRanking}”按专业相关性、复杂度、个人贡献、成果与动机价值从高到低逐段问完；不得机械按列举顺序，也不得先问课程作业。`
    }
  }

  let responseDimension = isPreludeObjective ? '' : authoritativeDimension
  let responseObjective = turnObjective || (authoritativeDimension ? `${authoritativeDimension}_follow_up` : 'conversation_opening')
  // State calculation above always uses the complete interview. Only the prose
  // generation window is bounded, so old facts cannot disappear from routing.
  const modelConversation = messages.slice(-60).map(message => ({
    role: message.role,
    content: message.content,
  }))
  let response = await streamDeepSeek(
    systemPrompt,
    modelConversation,
  )
  // Prompts are not an enforcement boundary. When the experience target has not
  // been met, never stream a model response that skips project discovery for a
  // later dimension. Buffer this high-risk transition, validate its actual
  // question, retry once, then use a deterministic safe question if necessary.
  const experienceTargetStillOpen = !isPreludeObjective && !cvText.trim() &&
    (['research', 'internship'].includes(authoritativeDimension) ||
      (authoritativeDimension === 'project' &&
        (!extracurricularStageAnswered || pendingProjectCandidates.length > 0 || onlyConfirmedProjectAvailability ||
          shouldAskSupplementalProjectInventory)))
  if (response.ok && !isPreludeObjective && authoritativeDimension === 'academic') {
    let draft = await response.text()
    const isAcademicQuestion = (text: string) => {
      if ((text.match(/[？?]/g) || []).length !== 1) return false
      if (classifyInterviewQuestion(text) !== 'academic' && !/\[ASKING[：:]\s*academic\]/i.test(text)) return false
      switch (turnObjective) {
        case 'academic_core_courses':
          return /(?:哪些|列出|说说).{0,16}(?:核心|专业|主干).{0,8}课/.test(text)
        case 'academic_focus_courses':
          return /(?:哪些|哪一门|哪几门|有没有).{0,30}(?:感兴趣|投入|收获|印象深刻|喜欢)/.test(text)
        case 'academic_course_profile':
          return Boolean(turnSubject && text.includes(turnSubject) &&
            /(?:课程|内容|学习|知识|制度|理论|理解|分析|判断|看待|思考|影响)/.test(text))
        case 'academic_course_profile_clarification':
          return Boolean(turnSubject && text.includes(turnSubject) &&
            /(?:一个|具体|印象|知识点|制度|理论|理解|分析|判断|变化)/.test(text))
        case 'academic_course_content':
          return Boolean(turnSubject && text.includes(turnSubject) && /(?:主要|具体).{0,12}(?:学习|讲|内容)|哪些内容|核心框架/.test(text))
        case 'academic_course_takeaway':
          return Boolean(turnSubject && text.includes(turnSubject) && /(?:方法|能力|框架|思维|视角|收获|影响)/.test(text))
        default:
          return classifyInterviewQuestion(text) === 'academic'
      }
    }
    if (!isAcademicQuestion(draft)) {
      const academicTask = turnObjective === 'academic_core_courses'
        ? '请申请者列出核心专业课'
        : turnObjective === 'academic_focus_courses'
          ? '请申请者从已列课程中选择感兴趣、投入较多或印象深刻的一门或多门'
          : turnObjective === 'academic_course_profile'
            ? `用一个综合问题了解“${turnSubject}”的具体学习内容如何影响申请者理解或分析专业问题`
          : turnObjective === 'academic_course_profile_clarification'
            ? `针对“${turnSubject}”只作一次具体澄清，不得重复上一问`
          : turnObjective === 'academic_course_content'
            ? `只询问“${turnSubject}”的课程内容`
            : `只询问“${turnSubject}”带来的个人收获或分析方法`
      const retryPrompt = `${systemPrompt}\n\n## 【上次生成未完成指定学术任务】\n刚才的问题与服务器指定任务不一致，已经被拦截。本轮唯一任务是：${academicTask}。不得提及项目、实践、实习、科研、申请动机或未来规划。末尾输出 [ASKING:academic]。`
      const retryResponse = await streamDeepSeek(
        retryPrompt,
        modelConversation,
      )
      if (retryResponse.ok) draft = await retryResponse.text()
    }
    if (!isAcademicQuestion(draft)) {
      switch (turnObjective) {
        case 'academic_core_courses':
          draft = '你们本科阶段主要学习了哪些核心专业课？\n\n[ASKING:academic]'
          break
        case 'academic_focus_courses':
          draft = '这些核心课程里，哪些是你比较感兴趣、投入较多或印象深刻的？可以说一门或多门。\n\n[ASKING:academic]'
          break
        case 'academic_course_profile':
          draft = `“${turnSubject || uncoveredFocusCourses[0]}”里，哪部分内容最影响你后来理解或处理专业问题的方式？${academicRecallGuide}。\n\n[ASKING:academic]`
          break
        case 'academic_course_profile_clarification':
          draft = `如果先从“${turnSubject || uncoveredFocusCourses[0]}”挑一个最有印象的具体内容，你最先想到什么？${academicRecallGuide}。\n\n[ASKING:academic]`
          break
        case 'academic_course_content':
          draft = `我们先聊“${turnSubject || uncoveredFocusCourses[0]}”：这门课主要学习了哪些内容？\n\n[ASKING:academic]`
          break
        case 'academic_course_takeaway':
          draft = `学完“${turnSubject || uncoveredFocusCourses[0]}”后，你现在分析一个具体法律问题时，会比以前多考虑哪一层？\n\n[ASKING:academic]`
          break
        default:
          draft = uncoveredFocusCourses[0]
            ? `我们继续聊“${uncoveredFocusCourses[0]}”：你还想从课程内容还是个人收获说起？\n\n[ASKING:academic]`
            : '这些核心课程里，哪些是你比较感兴趣、投入较多或印象深刻的？\n\n[ASKING:academic]'
      }
    }
    draft = draft
      .replace(/\[ASKING[：:]\s*(?:academic|research|internship|project|motivation|plan|personal)\]/gi, '')
      .replace(/\[(?:COVERED|EMPTY|DEFERRED)[：:]\s*(?:academic|research|internship|project|motivation|plan|personal)\]/gi, '')
      .trim()
    responseDimension = 'academic'
    responseObjective = turnObjective || 'academic_follow_up'
    response = new Response(`${draft}\n\n[ASKING:academic]`, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } else if (response.ok && experienceTargetStillOpen) {
    const skipsToLaterDimension = (draft: string) => {
      const detected = classifyInterviewQuestion(draft)
      const questionText = draft.match(/[^。！？!?\n]*[？?]/g)?.at(-1) || draft
      const escapedToMotivation = /(?:为什么|为何|是什么让你).{0,30}(?:申请|选择|继续读|专业|方向)|(?:申请|专业|方向).{0,30}(?:原因|动机|吸引|感兴趣)|(?:感兴趣|兴趣).{0,20}(?:专业|方向)/.test(questionText) ||
        Boolean(quickInfo?.targetMajor?.trim() && questionText.includes(quickInfo.targetMajor.trim()) &&
          /感兴趣|兴趣|吸引|选择|申请|决定/.test(questionText))
      const escapedToPlan = /毕业后|读完.{0,16}(?:硕士|项目)|未来.{0,12}(?:规划|打算|方向)|职业.{0,12}(?:规划|方向|目标)/.test(questionText)
      return detected === 'motivation' || detected === 'plan' ||
        escapedToMotivation || escapedToPlan ||
        /\[ASKING[：:]\s*(?:motivation|plan|personal)\]/i.test(draft)
    }
    const hasCurrentProjectContext = Boolean(
      pendingDiscoveredProject ||
      (activeExperience && (experienceDimensionByName.get(normalizeName(activeExperience)) === 'project' || authoritativeDimension === 'project')),
    )
    const asksProjectQuestion = (draft: string) =>
      classifyInterviewQuestion(draft) === 'project' ||
      (/\[ASKING[：:]\s*project\]/i.test(draft) && !skipsToLaterDimension(draft)) ||
      // Once a concrete project is locked, an elliptical follow-up is natural:
      // “后来怎么解决的？” should not be rejected merely for omitting “项目”.
      (hasCurrentProjectContext && /[？?]/.test(draft) && !skipsToLaterDimension(draft) &&
        classifyInterviewQuestion(draft) !== 'academic' &&
        classifyInterviewQuestion(draft) !== 'research' &&
        classifyInterviewQuestion(draft) !== 'internship')

    let draft = await response.text()
    const questionCount = (draft.match(/[？?]/g) || []).length
    const projectOpeningIsBundled = (text: string) => {
      if (!['project_open_experience', 'project_identify_experience'].includes(turnObjective)) return false
      const question = text.match(/[^。！？!?\n]*[？?]/)?.[0] || text
      const facets = [
        /题目|主题|赛题|背景|是什么(?:比赛|竞赛|大赛|项目)|做什么|完成什么任务/,
        /分工|角色|你.{0,12}(?:负责|承担|贡献|做了什么)/,
        /困难|挑战|难点|棘手|瓶颈/,
        /怎么|如何|解决|处理|应对|调整/,
        /结果|成果|成绩|获奖|反馈|产出/,
        /收获|反思|学到|意识到/,
      ].filter(pattern => pattern.test(question)).length
      return facets > 1
    }
    const projectOpeningPrematurelyDone = (text: string) => {
      if (!['project_open_experience', 'project_identify_experience'].includes(turnObjective) || !turnSubject) {
        return false
      }
      const completedNames = Array.from(
        text.matchAll(/\[EXP_DONE[：:]\s*([^\]]+)\]/gi),
        match => match[1].trim(),
      )
      return completedNames.some(name => isLikelyExperienceAlias(name, turnSubject))
    }
    const projectInventoryWordingIsInvalid = (text: string) => {
      if (turnObjective !== 'project_inventory') return false
      const questionEnd = text.search(/[？?]/)
      const leadAndQuestion = questionEnd >= 0 ? text.slice(0, questionEnd) : text
      const leadSentenceCount = (leadAndQuestion.match(/[。！!]/g) || []).length
      return leadSentenceCount > 1 || /哪些[^？?]{0,80}吗[？?]/.test(text)
    }
    const violatesProjectSubstate = (text: string) => {
      if (authoritativeDimension !== 'project') return false
      const questionText = text.match(/[^。！？!?\n]*[？?]/g)?.at(-1) || text
      if (turnObjective === 'project_open_experience') {
        return !/(?:负责|承担|亲手|贡献|角色|哪一部分|哪个部分|做了什么)/.test(questionText)
      }
      if (turnObjective === 'project_deep_dive_process') {
        return !/(?:困难|挑战|难点|阻力|噪音|问题|异常|判断|取舍|棘手|卡住|怎么|如何|处理|应对|筛选|验证|调整|解决)/.test(questionText)
      }
      if (turnObjective === 'project_deep_dive_outcome') {
        return !/(?:结果|成果|反馈|收获|反思|影响|产出|成绩|评价|落地|最后|最终)/.test(questionText)
      }
      return false
    }
    const switchesAwayFromServerProject = (text: string) => {
      if (authoritativeDimension !== 'project' || !turnSubject ||
          ['project_inventory', 'project_supplemental_inventory', 'project_identify_experience']
            .includes(turnObjective)) return false
      const openedNames = Array.from(text.matchAll(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/gi), match => match[1].trim())
      if (openedNames.some(name => !isLikelyExperienceAlias(name, turnSubject))) return true
      return allDiscoveredProjectNames.some(name =>
        !isLikelyExperienceAlias(name, turnSubject) &&
        text.includes(name))
    }
    const lockedExperienceSubject = turnSubject || (
      activeExperience && !verifiedCompletedExperienceNames
        .some(completed => isLikelyExperienceAlias(activeExperience, completed))
        ? activeExperience
        : ''
    )
    const switchesAwayFromLockedExperience = (text: string) => {
      if (!lockedExperienceSubject ||
          !['research', 'internship', 'project'].includes(authoritativeDimension)) return false
      const openedNames = Array.from(text.matchAll(/\[EXP(?!_DONE)[：:]\s*([^\]]+)\]/gi), match => match[1].trim())
      return openedNames.some(name => !isLikelyExperienceAlias(name, lockedExperienceSubject))
    }
    const mislabelsShortAnswerAsPaste = latestUserAnswer.length <= 12 &&
      /(?:重复粘贴|复制了一遍|上一条内容.{0,8}重复)/.test(draft)
    const mischaracterizesRephrase = (text: string) => controlAction === 'rephrase' &&
      /(?:重复粘贴|复制(?:了|的)?内容|输入有误|已经回答过|上一段内容.{0,8}重复)/.test(text)
    const missesInventoryIntent = (text: string) =>
      ['project_inventory', 'project_supplemental_inventory'].includes(turnObjective) &&
      !/(?:(?:还有|其他|另外|除此之外|除.{0,12}外).{0,40}(?:项目|竞赛|比赛|实践|活动|经历)|(?:项目|竞赛|比赛|实践|活动|经历).{0,30}(?:还有|其他|补充|列出))/.test(text)
    const mixesCurrentAndNextExperience = Boolean(activeExperience || pendingDiscoveredProject) &&
      questionCount >= 2 &&
      /(?:接下来|再来|接着|然后).{0,24}(?:聊|听听|看看).{0,20}(?:下一|另一|那段|法律援助|课程论文|模拟法庭|项目|经历)/.test(draft)
    const prematurelyClosesWhileAsking = questionCount >= 1 &&
      /(?:已经|这里|这段).{0,12}(?:聊得|聊到|信息).{0,8}(?:充分|完整|这里|够了)/.test(draft) &&
      /(?:接下来|再来|接着|然后)/.test(draft)
    const invalidDraft = questionCount !== 1 || (authoritativeDimension === 'project'
      ? !asksProjectQuestion(draft) || mixesCurrentAndNextExperience || prematurelyClosesWhileAsking ||
        mislabelsShortAnswerAsPaste || mischaracterizesRephrase(draft) || missesInventoryIntent(draft) || projectOpeningIsBundled(draft) || projectOpeningPrematurelyDone(draft) ||
        projectInventoryWordingIsInvalid(draft) || switchesAwayFromServerProject(draft) ||
        violatesProjectSubstate(draft) || switchesAwayFromLockedExperience(draft)
      : skipsToLaterDimension(draft) || switchesAwayFromLockedExperience(draft))
    if (invalidDraft) {
      const currentHasDepth = hasDimensionDepth(authoritativeDimension, 3)
      const requiredAction = currentHasDepth
        ? '当前科研/实习已经获得充分回答，可以简短收束，但唯一的新问题必须用于发现项目经历，并输出 [ASKING:project]。'
        : `当前 ${authoritativeDimension} 尚未完成，只能继续追问这段经历的一个核心细节，并输出 [ASKING:${authoritativeDimension}]。`
      const retryPrompt = `${systemPrompt}\n\n## 【上次生成未通过服务器校验】\n你刚才偏离了服务器指定的当前经历任务、擅自切换了项目，或在一个问题中捆绑了多个信息点；该结果已被拦截。${requiredAction}服务器指定的当前项目是“${turnSubject || '当前经历'}”，不得提问、预告或输出 [EXP:] 打开其他项目。项目首问只能从项目内容、个人分工中选择一项询问，不能同时问两项；尚未收到首问回答时禁止输出 [EXP_DONE:]。不得出现任何申请原因、毕业规划或个人特质问题。`
      const retryResponse = await streamDeepSeek(
        retryPrompt,
        modelConversation,
      )
      if (retryResponse.ok) draft = await retryResponse.text()
    }
    const retryQuestionCount = (draft.match(/[？?]/g) || []).length
    const retryMixesExperiences = Boolean(activeExperience || pendingDiscoveredProject) && retryQuestionCount >= 2 &&
      /(?:接下来|再来|接着|然后).{0,24}(?:聊|听听|看看).{0,20}(?:下一|另一|那段|法律援助|课程论文|模拟法庭|项目|经历)/.test(draft)
    const retryStillInvalid = (draft.match(/[？?]/g) || []).length !== 1 || (authoritativeDimension === 'project'
      ? !asksProjectQuestion(draft) || retryMixesExperiences ||
        mischaracterizesRephrase(draft) || missesInventoryIntent(draft) || projectOpeningIsBundled(draft) || projectOpeningPrematurelyDone(draft) ||
        projectInventoryWordingIsInvalid(draft) || switchesAwayFromServerProject(draft) ||
        violatesProjectSubstate(draft) || switchesAwayFromLockedExperience(draft)
      : skipsToLaterDimension(draft) || switchesAwayFromLockedExperience(draft))
    if (retryStillInvalid) {
      const latestUserAnswer = [...messages].reverse().find(message => message.role === 'user')?.content.trim() || ''
      const introducedExperienceName = latestUserAnswer
        .split(/[：:。；;！!\n]/)[0].replace(/[\*#「」『』]/g, '').trim().slice(0, 40)
      const latestAnswerIntroducesExperience = introducedExperienceName.length >= 2 &&
        /实习|科研|课题|论文|竞赛|比赛|大赛|项目|模拟法庭|法律援助|社会实践|志愿|社团|学生组织|课程设计|毕业设计|大作业/.test(introducedExperienceName) &&
        !/^(?:我)?有(?:过)?(?:一|二|两|三|四|几|多)?段?(?:相关的?)?(?:竞赛|比赛|大赛|个人项目|开源项目|项目|实践)(?:经历)?[了呢啊吧。！!\s]*$/.test(introducedExperienceName) &&
        !/^(?:这|该|那)(?:篇|个|项|段).{0,30}(?:是|由|属于|完成|负责|获得|得到)/.test(introducedExperienceName) &&
        !/^(?:最|主要)?(?:棘手|困难|难点|问题|挑战|结果|收获|解决)/.test(introducedExperienceName)
      if (authoritativeDimension !== 'project' && !hasDimensionDepth(authoritativeDimension, 3)) {
        draft = latestAnswerIntroducesExperience
          ? `你刚提到的“${introducedExperienceName}”很值得展开。先从一个具体场景聊起：这段经历里，哪件事最需要你亲自判断或解决？\n\n[ASKING:${authoritativeDimension}]`
          : `刚才这段经历里，有没有一件最需要你亲自判断或解决的事？我们先聊这个具体场景。\n\n[ASKING:${authoritativeDimension}]`
      } else {
        draft = turnObjective === 'project_deep_dive_process' && turnSubject
          ? `继续说“${turnSubject}”：其中哪次关键判断或处理最值得展开，你当时具体是怎么做的？\n\n[ASKING:project]`
          : turnObjective === 'project_deep_dive_outcome' && turnSubject
            ? `“${turnSubject}”最后形成了什么结果，或者得到了什么具体反馈？\n\n[ASKING:project]`
          : turnObjective === 'project_open_experience' && turnSubject
            ? `我们先从“${turnSubject}”说起。你在这段经历中主要负责哪一部分？\n\n[ASKING:project]`
          : turnObjective === 'project_identify_experience'
            ? `你提到有相关经历，具体是哪一项比赛、项目或实践？先说名称和大致内容就好。\n\n[ASKING:project]`
          : latestAnswerIntroducesExperience
            ? `你刚提到的“${introducedExperienceName}”很值得继续聊。我们先聚焦这一次经历：当时最棘手的问题是什么？\n\n[ASKING:project]`
            : onlyConfirmedProjectAvailability
              ? '好呀，那我们就从这段竞赛聊起。它具体是什么比赛，当时需要完成什么任务？你先简单介绍一下背景就好。\n\n[ASKING:project]'
              : shouldAskSupplementalProjectInventory
                ? '目前有效经历还不到三段，我只再确认这一次：除了已经聊过的内容，你还有一段课程项目、竞赛、实践或学生组织经历可以补充吗？没有也完全没关系。\n\n[ASKING:project]'
                : `${projectInventoryQuestion}\n\n[ASKING:project]`
      }
    }
    // A response that still asks about the locked item cannot complete that same
    // item or the whole dimension. Keep older-item EXP_DONE markers intact when
    // the server is intentionally opening the next item.
    if (lockedExperienceSubject) {
      draft = draft
        .replace(/\[EXP_DONE[：:]\s*([^\]]+)\]/gi, (tag, name: string) =>
          isLikelyExperienceAlias(name.trim(), lockedExperienceSubject) ? '' : tag)
        .replace(new RegExp(`\\[COVERED[：:]\\s*${authoritativeDimension}\\]`, 'gi'), '')
        .trim()
    }
    const validatedDimension = classifyInterviewQuestion(draft) ||
      draft.match(/\[ASKING[：:]\s*(academic|research|internship|project|motivation|plan)\]/i)?.[1] || ''
    if (validatedDimension) {
      responseDimension = validatedDimension
      if (validatedDimension !== authoritativeDimension) responseObjective = `${validatedDimension}_discovery`
    }
    response = new Response(draft, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  } else if (response.ok && ['motivation', 'plan'].includes(authoritativeDimension)) {
    // The late-stage order is just as authoritative as the experience gate.
    // Buffer these transitions so the model cannot skip plan or ask two
    // dimensions in one turn merely because its prose sounds plausible.
    let draft = await response.text()
    const detectsDimension = (text: string) => classifyInterviewQuestion(text) ||
      text.match(/\[ASKING[：:]\s*(academic|research|internship|project|motivation|plan)\]/i)?.[1] || ''
    const violatesLateStageContract = (text: string) => {
      if ((text.match(/[？?]/g) || []).length !== 1) return true
      if (detectsDimension(text) !== authoritativeDimension) return true
      const claimedDirectionText = text.match(/申请.{0,24}?([\u4e00-\u9fa5A-Za-z]{2,12}方向)/)?.[1] || ''
      const claimsUnconfirmedSpecialization = Boolean(claimedDirectionText) &&
        !/^(?:(?:这个)?专业或方向|这个方向|该方向|当前方向|目标方向|研究方向)$/.test(claimedDirectionText) &&
        !hasUserConfirmedApplicationSpecialization && !/(?:方向|track|speciali[sz]ation)/i.test(quickInfo?.targetMajor || '')
      if (claimsUnconfirmedSpecialization) return true
      if (authoritativeDimension === 'motivation' &&
          /(?:最棘手|最大困难|遇到.{0,8}(?:困难|挑战)|具体怎么做|怎么解决|如何解决|最后结果)/.test(text)) return true
      if (authoritativeDimension === 'motivation' && turnObjective === 'motivation_school' &&
          /比如.{0,60}(?:课程|老师|教师|研究|实践|司法|制度)|是.{0,30}(?:课程|师资|老师).{0,20}还是/.test(text)) return true
      if (authoritativeDimension === 'plan' && turnObjective !== 'plan_follow_up' &&
          /(?:五年|5年|三到五年|3[—-]5年)后/.test(text) && !/(?:毕业后|短期|第一步)/.test(text)) return true
      return false
    }
    if (violatesLateStageContract(draft)) {
      const retryPrompt = `${systemPrompt}\n\n## 【上次生成未通过顺序校验】\n你刚才的问题不属于服务器指定的 ${authoritativeDimension} 维度。只自然回应用户上一条内容，然后只问 ${authoritativeDimension} 的一个核心问题，不得涉及其他维度。末尾必须输出 [ASKING:${authoritativeDimension}]。`
      const retryResponse = await streamDeepSeek(
        retryPrompt,
        modelConversation,
      )
      if (retryResponse.ok) draft = await retryResponse.text()
    }
    if (violatesLateStageContract(draft)) {
      draft = authoritativeDimension === 'motivation'
        ? (turnObjective === 'motivation_school'
          ? `你实际了解过目标院校或所在地区的哪些资源，其中什么最适合你想深入的方向？\n\n[ASKING:motivation]`
          : `结合刚才聊过的经历，是什么让你最终确定要继续申请这个专业或方向？\n\n[ASKING:motivation]`)
        : `读完这个硕士项目后，你希望自己的第一步是什么，先进入哪类工作或继续哪方面的研究？\n\n[ASKING:plan]`
    }

    // Hidden progress tags are model output too, so validate them independently
    // from the visible question. A motivation question carrying [ASKING:plan]
    // used to make the next school-motivation answer count as a plan answer.
    draft = draft
      .replace(/\[ASKING[：:]\s*(?:academic|research|internship|project|motivation|plan|personal)\]/gi, '')
      .replace(/\[(COVERED|EMPTY|DEFERRED)[：:]\s*(academic|research|internship|project|motivation|plan|personal)\]/gi,
        (tag, eventType: string, dimension: string) => {
          const taggedIndex = ALL_DIMENSIONS.indexOf(dimension)
          const authoritativeIndex = ALL_DIMENSIONS.indexOf(authoritativeDimension)
          if (taggedIndex < 0) return ''
          // The current response asks this dimension; it cannot also complete it
          // before the applicant replies. Preserve only an explicit deferral of
          // the current topic, plus valid terminal events from earlier topics.
          if (taggedIndex > authoritativeIndex) return ''
          if (taggedIndex === authoritativeIndex && eventType.toUpperCase() !== 'DEFERRED') return ''
          return tag
        })
      .trim()
    draft = `${draft}\n\n[ASKING:${authoritativeDimension}]`
    responseDimension = authoritativeDimension
    response = new Response(draft, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  // Final server-side output boundary. Model instructions and malformed control
  // notes must never become visible interview prose. Buffering here preserves the
  // response contract while ensuring every generation path receives the filter.
  if (response.ok) {
    let safeDraft = await response.text()
    safeDraft = safeDraft
      .replace(/^\s*[（(][^\n]*(?:如果没有回答|若有则标记|保持过滤|EXP:|ASKING:|COVERED:)[^\n]*[）)]\s*$/gmi, '')
      .replace(/^\s*(?:系统指令|内部指令|流程指令)[：:].*$/gmi, '')
    if (missing.length > 0) {
      safeDraft = safeDraft.replace(/\[INTERVIEW_COMPLETE\]/gi, '')
    }
    response = new Response(safeDraft.trim(), {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  if (responseDimension) {
    response.headers.set('X-Interview-Dimension', responseDimension)
  }
  if (responseObjective) response.headers.set('X-Interview-Objective', responseObjective)
  const unresolvedActiveExperience = activeExperience &&
    !verifiedCompletedExperienceNames.some(completed => isLikelyExperienceAlias(activeExperience, completed))
      ? activeExperience
      : ''
  const responseExperienceSubject = turnSubject || unresolvedActiveExperience
  if (responseExperienceSubject) {
    // turnSubject is the item selected by the server for this response. The
    // client may still send the just-completed previous item as activeExperience.
    response.headers.set('X-Interview-Subject', encodeURIComponent(responseExperienceSubject))
  }
  if (turnSubjectId) {
    response.headers.set('X-Interview-Subject-Id', encodeURIComponent(turnSubjectId))
  }
  response.headers.set(
    'X-Interview-Covered',
    effectiveCoveredDimensions.filter(dimension => !effectiveEmptyDimensions.includes(dimension)).join(','),
  )
  response.headers.set('X-Interview-Empty', effectiveEmptyDimensions.join(','))
  response.headers.set('X-Interview-Experience-Count', String(concreteExperienceCount))
  response.headers.set('X-Interview-Plan', encodeURIComponent(JSON.stringify({
    dimension: responseDimension,
    objective: responseObjective,
    subject: responseExperienceSubject,
    subjectId: turnSubjectId,
    effectiveExperienceCount: concreteExperienceCount,
  })))
  response.headers.set(
    'X-Interview-Needs-More-Experiences',
    shouldAskSupplementalProjectInventory ? 'true' : 'false',
  )
  return response
}
