export interface Message {
  /** Stable identity used to bind a user answer to the exact AI question. */
  id?: string
  role: 'user' | 'assistant'
  content: string
  rawContent?: string  // original AI response with hidden tags (for detection only)
  /** For user messages: the assistant message this answer belongs to. */
  replyToMessageId?: string
  /** Server-selected topic for this assistant question; authoritative for progress. */
  questionDimension?: string
  /** Optional state-machine objective, e.g. challenge/result/availability. */
  questionObjective?: string
  /** Concrete item being discussed, e.g. a course, internship or project. */
  questionSubject?: string
  /** Stable queue identity for an experience. Names are display labels only. */
  questionSubjectId?: string
  /** Authoritative sidebar changes emitted by a question or its direct answer. */
  progressEvents?: InterviewProgressEvent[]
}

/** Server-owned plan for one assistant turn. The model may phrase it naturally,
 * but it cannot choose a different workflow state. */
export interface InterviewTurnPlan {
  dimension: string
  objective: string
  subject: string
  subjectId?: string
  effectiveExperienceCount: number
}

export type InterviewProgressEventType =
  | 'dimension_started'
  | 'dimension_available'
  | 'dimension_completed'
  | 'dimension_empty'
  | 'dimension_deferred'
  | 'experience_retracted'
  | 'interview_completed'

export interface InterviewProgressEvent {
  type: InterviewProgressEventType
  dimension?: string
  experience?: string
}

export interface Persona {
  id: string        // 'A' | 'B' | 'C'
  title: string     // 4-8 chars, e.g. "工程实践派"
  tagline: string   // one-line angle, ~20 chars
  description: string  // what story this persona tells
  evidence: string     // specific interview experiences that support it
  focus: string        // what the essay should emphasize
}

export interface FrameworkSection {
  section: string
  purpose: string
  keyPoints: string[]
  suggestedContent: string
}

export type EssayType = 'SOP' | 'PS'

export const ESSAY_TYPE_META: Record<EssayType, { label: string; desc: string; icon: string }> = {
  SOP: { label: 'SOP', desc: '学术目的陈述 · 侧重研究动机与学术背景', icon: '🎓' },
  PS: { label: 'PS', desc: '个人陈述 · 侧重个人故事与成长经历', icon: '✍️' },
}

export const INTERVIEW_DIMENSIONS = [
  { key: 'academic',   label: '学术背景' },
  { key: 'research',   label: '科研经历' },
  { key: 'internship', label: '实习经历' },
  { key: 'project',    label: '项目经历' },
  { key: 'motivation', label: '申请动机' },
  { key: 'plan',       label: '未来规划' },
]
