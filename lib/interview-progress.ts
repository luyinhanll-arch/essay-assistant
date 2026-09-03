import type { Message } from './types'

export const INTERVIEW_DIMENSION_ORDER = [
  'academic', 'research', 'internship', 'project', 'motivation', 'plan', 'personal',
] as const

export type InterviewDimension = typeof INTERVIEW_DIMENSION_ORDER[number]

/**
 * Detect a genuine interview farewell without depending on model-only tags.
 * Keep this language generic so it works for every school, major and interview.
 */
export function isExplicitInterviewConclusion(text: string): boolean {
  const clean = text.replace(/\[[^\]]+\]/g, '').trim()
  const closesInterview =
    /(?:采访|访谈|今天(?:的)?(?:采访|访谈|交流)|各个维度).{0,24}(?:到这里|到此|结束|完成|聊完|告一段落)|(?:到这里|聊到这里).{0,16}(?:采访|访谈).{0,12}(?:结束|完成)|我们.{0,16}(?:把|将).{0,16}(?:各个维度|所有维度).{0,12}(?:聊完|完成)/.test(clean)
  const handsOffToNextStep =
    /(?:接下来|下一步).{0,50}(?:选择|提炼|生成|整理).{0,20}(?:人设|叙事方向|文书方向)|(?:选择人设|人设方向).{0,20}(?:按钮|页面|下一步)/.test(clean)
  const farewell = /谢谢你.{0,24}(?:坦诚|耐心|分享|和我聊)|期待看到你.{0,20}(?:最终|最后).{0,10}(?:表达|文书)|(?:采访|访谈).{0,12}(?:辛苦了|完成了)/.test(clean)

  return closesInterview || handsOffToNextStep || (farewell && /(?:接下来|下一步|结束|完成)/.test(clean))
}

/**
 * Classify only explicit question intent, not incidental nouns. For example,
 * “这个项目里最大的困难是什么” remains unknown without context and therefore
 * inherits its authoritative internship/research metadata; asking for a course
 * paper or design explicitly is a project transition.
 */
export function classifyInterviewQuestion(text: string): InterviewDimension | null {
  if (!/[？?]/.test(text)) return null
  const withoutTags = text.replace(/\[[^\]]+\]/g, '')

  // A turn often introduces the next subject explicitly, then ends with an
  // elliptical follow-up such as “你负责什么角色？”. Classifying only that last
  // sentence would incorrectly inherit the previous dimension. Detect explicit
  // whole-turn transitions before narrowing to the final core question.
  if (/(?:接下来|下面|然后|除了|想(?:再|单独)?了解|聊聊|先问问).{0,100}(?:项目|活动|大作业|课程设计|课程论文|毕业设计|竞赛|比赛|模拟法庭|法律援助|社会实践|公益|志愿|社团|学生组织).{0,160}[？?]/.test(withoutTags) ||
      /(?:模拟法庭|法律援助|竞赛|比赛|个人项目|课程项目|课程设计|课程论文|毕业设计|社会实践|公益活动|志愿活动|社团工作).{0,120}(?:负责|角色|做了什么|困难|挑战|结果|成果).{0,40}[？?]/.test(withoutTags)) {
    return 'project'
  }
  if (/(?:接下来|下面|然后|聊聊|先问问).{0,80}(?:科研|研究经历|实验室|课题组).{0,120}[？?]/.test(withoutTags)) {
    return 'research'
  }
  if (/(?:接下来|下面|然后|聊聊|先问问).{0,80}(?:实习经历|正式实习|第[一二两三四]段实习|下一段实习).{0,120}[？?]/.test(withoutTags)) {
    return 'internship'
  }
  // A clear planning question is often followed by a shorter, elliptical
  // question in the same turn. Inspect the whole turn before narrowing to its
  // final sentence so “毕业后往哪个方向发展？……更具体的领域呢？” stays plan.
  if (/(?:毕业后|毕业之后|硕士(?:毕业|读完|结束)后|(?:完成|读完).{0,24}(?:硕士|项目).{0,16}(?:之后|以后)).{0,180}(?:希望|打算|倾向|方向|职业|工作|读博|长期|领域|场景).{0,100}[？?]/.test(withoutTags)) {
    return 'plan'
  }
  const questionEnd = Math.max(withoutTags.lastIndexOf('？'), withoutTags.lastIndexOf('?'))
  const prefix = withoutTags.slice(0, questionEnd + 1)
  const questionStart = Math.max(
    prefix.lastIndexOf('\n'), prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('!'),
  )
  const clean = prefix.slice(questionStart + 1).trim()

  if (/课程(?:中|里|之外|以外)?.{0,30}(?:大作业|课程项目|课程设计|课程论文|毕业论文|毕业设计)|(?:大作业|课程设计|课程论文|毕业设计).{0,24}(?:有没有|哪|介绍|讲|做过)|(?:竞赛|个人项目|社团|志愿|社会实践).{0,24}(?:有没有|做过|参加过)/.test(clean)) return 'project'
  if (/(?:第[一二两三四]|下一段|另一段).{0,16}实习|实习.{0,24}(?:哪家公司|什么岗位|主要负责|做了什么)|在哪家.{0,12}(?:公司|机构).{0,12}实习/.test(clean)) return 'internship'
  if (/(?:正式)?(?:科研|研究经历).{0,24}(?:有没有|做过|介绍|课题|成果)|(?:这段|该段|你的).{0,12}(?:科研|研究).{0,20}(?:课题|做什么|方向|内容)|(?:加入|参加).{0,12}(?:实验室|课题组)|在哪个?.{0,16}(?:实验室|课题组).{0,12}(?:做|开展|参与)|(?:实验室|课题组).{0,20}(?:什么角色|承担|负责|做了什么)|(?:发表|投稿).{0,12}论文/.test(clean)) return 'research'
  if (/(?:核心|专业|重点).{0,10}课程|哪些.{0,12}(?:核心|专业)课|哪(?:一|几)门课.{0,20}(?:感兴趣|投入|收获|印象)|(?:这门|这些)课.{0,30}(?:学到|内容|方法|能力|收获)/.test(clean)) return 'academic'
  if (/申请动机|(?:为什么|为何).{0,28}(?:申请|选择|深造|继续读|想去|考虑)|(?:是什么|哪些).{0,16}(?:让|使).{0,8}你.{0,40}(?:决定申请|想申请|选择|继续读|继续深造|深入研究|深耕|感兴趣|产生兴趣)|是什么让你对.{0,32}(?:专业|方向|领域|学校|院校|项目).{0,24}(?:产生|有了|感到).{0,10}(?:热情|兴趣)|(?:专业|方向|领域|学校|院校|项目).{0,36}(?:吸引你|感兴趣|选择原因|申请原因|契合)|(?:最吸引你的是什么|哪些地方吸引你|吸引你的地方|为什么想去|为什么考虑它|为什么选择它)|什么时候.{0,16}(?:意识到|确定|决定).{0,24}(?:深入研究|继续深造|申请)|从什么时候开始.{0,20}(?:想深入|想继续|确定方向)/i.test(clean)) return 'motivation'
  if (/毕业后|硕士(?:毕业|读完|结束)后|读完.{0,20}(?:硕士|项目).{0,12}(?:之后|以后)|未来.{0,12}(?:规划|打算|方向)|职业.{0,12}(?:规划|方向|目标)|读完.{0,12}(?:之后|以后)|继续读博.{0,12}(?:还是|或者).{0,12}(?:就业|工作|进入业界)|(?:进入业界|找工作).{0,16}(?:还是|或者).{0,12}(?:读博|学术研究)|短期.{0,12}(?:打算|目标).{0,16}(?:长期|长远)/.test(clean)) return 'plan'
  if (/个人特质|关于你这个人|你觉得自己是怎样的人|你自己有没有意识到.{0,36}(?:特点|特质|模式|习惯|风格)|你自己有没有这种感觉|什么样的性格|你身上.{0,16}(?:特点|特质|模式|风格)|注意到你有.{0,28}(?:模式|特点|习惯|风格)|这是你.{0,20}(?:自然状态|养成的习惯|思维方式|做事风格)|面对问题时.{0,16}(?:自然状态|习惯|方式|风格)|你是否认同.{0,20}(?:总结|判断|特质|模式|观察)|(?:认同|同意).{0,12}(?:这个|这种).{0,12}(?:总结|观察|特点|模式|做事风格)/.test(clean)) return 'personal'
  return null
}

const CORE_COURSES_QUESTION = /哪些.{0,12}(?:核心|专业|主干).{0,6}课|(?:核心|专业|主干).{0,8}(?:课程|专业课)|列举.{0,8}(?:课程|专业课)/
const FOCUS_COURSES_QUESTION = /(?:(?:哪一门|哪几门|哪门|有没有|哪些课|这些.{0,8}课程).{0,30}(?:投入|收获|印象深刻|感兴趣|兴趣|喜欢)|(?:感兴趣|印象深刻|收获较大).{0,16}(?:课程|课))/

function firstUserAnswerAfter(messages: Message[], questionIndex: number): string {
  return questionIndex >= 0
    ? messages.slice(questionIndex + 1).find(message => message.role === 'user')?.content.trim() || ''
    : ''
}

/** Courses explicitly selected by the applicant for deeper academic discussion. */
export function getFocusCourseNames(messages: Message[]): string[] {
  // Prefer the server-owned objective. A core-course inventory question may
  // casually contain words such as “印象里重要”, which must not make its entire
  // answer become the focus-course list.
  const objectiveIndex = messages.findIndex(message =>
    message.role === 'assistant' && message.questionObjective === 'academic_focus_courses')
  const focusIndex = objectiveIndex >= 0 ? objectiveIndex : messages.findIndex(message =>
    message.role === 'assistant' && FOCUS_COURSES_QUESTION.test(message.rawContent ?? message.content))
  const answer = firstUserAnswerAfter(messages, focusIndex)
  if (!answer || /^(?:没有|没|无|都差不多|没有特别)/.test(answer)) return []
  return Array.from(new Set(answer
    .replace(/^(?:我|主要|比较|最)?(?:喜欢|感兴趣|投入较多|印象深刻)?(?:的是|是)?/, '')
    .split(/[、，,；;、]|和|以及|与/)
    .map(value => value
      .replace(/[。！!？?].*$/, '')
      .replace(/(?:吧|呢|啊|呀|嘛|啦)$/u, '')
      .trim())
    .filter(value => value.length >= 2 && value.length <= 24)))
}

export function getUncoveredFocusCourses(messages: Message[]): string[] {
  const names = getFocusCourseNames(messages)
  return names.filter(name => getAcademicCourseGap(messages, name) !== null)
}

export type AcademicCourseGap = 'content' | 'takeaway' | null

/** A selected course is complete only after both factual content and the
 * applicant's own learning/method evidence have been collected. */
export function getAcademicCourseGap(messages: Message[], name: string): AcademicCourseGap {
  const relatedQuestions = messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return []
    const source = message.rawContent ?? message.content
    const subjectMatches = source.includes(name) || message.questionSubject === name
    return subjectMatches && /[？?]/.test(source) ? [{ source, index, objective: message.questionObjective }] : []
  })
  const profileQuestion = relatedQuestions.find(({ objective }) =>
    objective === 'academic_course_profile')
  const profileAnswer = profileQuestion ? firstUserAnswerAfter(messages, profileQuestion.index) : ''
  const declinedProfile = /^(?:没有特别(?:的)?|没什么|不想展开|不记得了?)[了呢啊。！!\s]*$/u.test(profileAnswer)
  // New interviews use one integrated course question. A substantive direct
  // answer completes the course without vocabulary-based semantic grading.
  if (profileAnswer && (profileAnswer.length >= 12 || declinedProfile)) return null
  const clarificationQuestion = relatedQuestions.find(({ objective }) =>
    objective === 'academic_course_profile_clarification')
  const clarificationAnswer = clarificationQuestion
    ? firstUserAnswerAfter(messages, clarificationQuestion.index)
    : ''
  // A course gets at most one clarification; after that response we move on.
  if (clarificationAnswer) return null

  const contentQuestion = relatedQuestions.find(({ source, objective }) =>
    objective === 'academic_course_content' || /(?:主要|具体).{0,10}(?:学了|讲了|内容)|哪些内容|内容板块|涵盖什么/.test(source))
  const contentAnswer = contentQuestion ? firstUserAnswerAfter(messages, contentQuestion.index) : ''
  if (!contentAnswer || contentAnswer.length < 12) return 'content'

  // A content answer may already contain the applicant's own reasoning change.
  // In that case, asking for an abstract “new perspective” merely repeats it.
  const contentAlreadyContainsTakeaway = contentAnswer.length >= 35 &&
    /(?:我|让我|使我|习惯|不再|学会|形成|能够|可以|会平衡|会权衡|会考虑|会结合).{0,32}(?:分析|判断|考量|平衡|权衡|视角|框架|方法|边界|尺度)|(?:不再|学会|形成).{0,32}(?:分析|判断|保护|看待|考量)/u.test(contentAnswer)
  if (contentAlreadyContainsTakeaway) return null

  const takeawayQuestion = relatedQuestions.find(({ source, objective }) =>
    objective === 'academic_course_takeaway' || /带来.{0,16}(?:方法|能力|框架|思维|收获)|(?:掌握|学会|形成|建立|提升).{0,16}(?:什么|哪些)|有什么.{0,12}(?:收获|影响|帮助)|如何分析|分析框架/.test(source))
  const takeawayAnswer = takeawayQuestion ? firstUserAnswerAfter(messages, takeawayQuestion.index) : ''
  // The question objective already establishes what the answer is about. Do not
  // require a vocabulary whitelist: “额外考量诉讼路径与程序可行性” is valid
  // method evidence even though it never says “分析方法” or “思维框架”.
  const declinedTakeaway = /^(?:不知道|不清楚|没有|没想过|说不上来|没什么)[了呢啊。！!\s]*$/u.test(takeawayAnswer)
  if (!takeawayAnswer || takeawayAnswer.length < 12 || declinedTakeaway) return 'takeaway'
  return null
}

/** Strict academic contract: every applicant-selected course needs direct depth. */
export function hasCompleteAcademicBackgroundEvidence(messages: Message[]): boolean {
  const coreObjectiveIndex = messages.findIndex(message =>
    message.role === 'assistant' && message.questionObjective === 'academic_core_courses')
  const focusObjectiveIndex = messages.findIndex(message =>
    message.role === 'assistant' && message.questionObjective === 'academic_focus_courses')
  const coreIndex = coreObjectiveIndex >= 0 ? coreObjectiveIndex : messages.findIndex(message =>
    message.role === 'assistant' && CORE_COURSES_QUESTION.test(message.rawContent ?? message.content))
  const focusIndex = focusObjectiveIndex >= 0 ? focusObjectiveIndex : messages.findIndex(message =>
    message.role === 'assistant' && FOCUS_COURSES_QUESTION.test(message.rawContent ?? message.content))
  if (!firstUserAnswerAfter(messages, coreIndex) || !firstUserAnswerAfter(messages, focusIndex)) return false
  const names = getFocusCourseNames(messages)
  if (names.length === 0) return true
  return getUncoveredFocusCourses(messages).length === 0
}

export interface InterviewProgressSnapshot {
  activeDimension: string | null
  coveredDimensions: string[]
  emptyDimensions: string[]
}

const VALID_DIMENSIONS = new Set<string>(INTERVIEW_DIMENSION_ORDER)

/**
 * Enforce the invariants of the sidebar state in one place.  In particular, an
 * empty/covered dimension can never remain active after an atomic server sync.
 */
export function normalizeInterviewProgress(
  progress: InterviewProgressSnapshot,
): InterviewProgressSnapshot {
  const emptyDimensions = Array.from(new Set(progress.emptyDimensions))
    .filter(dimension => VALID_DIMENSIONS.has(dimension))
  const empty = new Set(emptyDimensions)
  const coveredDimensions = Array.from(new Set(progress.coveredDimensions))
    .filter(dimension => VALID_DIMENSIONS.has(dimension) && !empty.has(dimension))
  const resolved = new Set([...emptyDimensions, ...coveredDimensions])
  const activeDimension = progress.activeDimension &&
    VALID_DIMENSIONS.has(progress.activeDimension) &&
    !resolved.has(progress.activeDimension)
      ? progress.activeDimension
      : null

  return { activeDimension, coveredDimensions, emptyDimensions }
}

export interface PreScreenAvailability {
  research: 'yes' | 'no' | 'unknown'
  internship: 'yes' | 'no' | 'unknown'
}

const NEGATIVE_PREFIX = '(?:没有|没(?:有)?|无|未|不曾|没做过|未做过)'
const RESEARCH_NOUN = '(?:正式)?(?:科研(?:经历)?|研究(?:经历)?|课题|实验室经历)'
const INTERNSHIP_NOUN = '(?:正式)?(?:实习(?:经历)?|兼职(?:经历)?)'

function availabilityFor(text: string, noun: string): 'yes' | 'no' | 'unknown' {
  // Never let a negation cross a clause boundary: in “有实习，没有科研”, the
  // second clause must not negate the internship mentioned in the first one.
  const SAME_CLAUSE = '[^，,。；;！？!?]'
  const negative = new RegExp(
    `${NEGATIVE_PREFIX}${SAME_CLAUSE}{0,8}${noun}|${noun}${SAME_CLAUSE}{0,8}${NEGATIVE_PREFIX}`,
  )
  if (negative.test(text)) return 'no'

  const positive = new RegExp(
    `(?:有|做过|参加过|参与过|加入过)${SAME_CLAUSE}{0,8}${noun}|${noun}${SAME_CLAUSE}{0,8}(?:有|做过|参加过|参与过|加入过)`,
  )
  return positive.test(text) ? 'yes' : 'unknown'
}

/** Read only the answer to the dedicated pre-screen availability question.
 * Later project-discovery questions may mention both prior internships and a
 * possible research project; they must not replace the original yes/no answer. */
export function extractPreScreenAvailability(messages: Message[]): PreScreenAvailability {
  let questionIndex = messages.findIndex(message =>
    message.role === 'assistant' && message.questionObjective === 'experience_availability')

  // Compatibility fallback for older persisted conversations without objective
  // metadata. The pre-screen is the first combined availability question and
  // occurs before formal academic interviewing starts.
  for (let index = 0; index < messages.length; index += 1) {
    if (questionIndex >= 0) break
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const source = message.rawContent ?? message.content
    if (/\[ASKING[：:]\s*academic\]/i.test(source) ||
        /(?:核心|专业|主干).{0,12}(?:课程|专业课)/.test(source)) break
    const explicitlyAsksInternshipAvailability = /(?:有没有|是否有|有无).{0,35}(?:正式)?实习|(?:正式)?实习.{0,20}(?:有没有|是否有|有无)/.test(source)
    const explicitlyAsksResearchAvailability = /(?:有没有|是否有|有无).{0,45}(?:科研|研究经历|实验室|课题|论文)|(?:科研|研究经历).{0,20}(?:有没有|是否有|有无)/.test(source)
    if (/[？?]/.test(source) && explicitlyAsksInternshipAvailability && explicitlyAsksResearchAvailability) {
      questionIndex = index
      break
    }
  }

  const answer = questionIndex >= 0
    ? messages.slice(questionIndex + 1).find(message => message.role === 'user')?.content.trim() || ''
    : ''
  if (!answer) return { research: 'unknown', internship: 'unknown' }

  // The combined prompt explicitly asks only whether either experience exists.
  // A bare negative therefore applies to both dimensions, not an unknown one.
  if (/^(?:没有|没|无|没有过|没做过|都没(?:有)?|两个都没(?:有)?|两项都没(?:有)?|这两个都没(?:有)?|这两项都没(?:有)?|均没(?:有)?|均无|都无|全都没(?:有)?|没有实习也没有科研)[了过啊呀呢吧。！!\s]*$/.test(answer)) {
    return { research: 'no', internship: 'no' }
  }

  return {
    research: availabilityFor(answer, RESEARCH_NOUN),
    internship: availabilityFor(answer, INTERNSHIP_NOUN),
  }
}
