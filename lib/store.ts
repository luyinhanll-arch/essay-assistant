'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Message, Persona, FrameworkSection, EssayType, InterviewProgressEvent } from './types'
import { INTERVIEW_DIMENSION_ORDER, normalizeInterviewProgress } from './interview-progress'

interface AppStore {
  /** v1 = legacy inference/calibration, v2 = message metadata + event reducer only. */
  interviewProtocolVersion: 1 | 2
  messages: Message[]
  cvText: string
  cvAnalysis: string
  interviewComplete: boolean
  coveredDimensions: string[]
  deferredDimensions: string[]                    // 暂缓维度（用户说不清楚，最后再回头）
  targetProgram: string   // e.g. "UCLA/Stanford | Computer Science | MS"
  personas: Persona[]           // AI生成的2-3个候选人设方向
  selectedPersona: Persona | null  // 用户选中的人设方向
  essayType: EssayType
  wordLimit: string
  schoolNotes: string
  frameworkGeneratedWith: { essayType: string; wordLimit: string; schoolNotes: string; personaId: string | number } | null
  framework: FrameworkSection[]
  draft: string
  dimensionSummaries: Record<string, string>      // 维度key -> AI总结
  dimensionMessageIndex: Record<string, number>   // 维度key -> 触发覆盖时的消息index
  expMessageIndex: Record<string, number>          // 经历名称 -> [EXP:] 标记所在的消息index
  activeExperience: string | null                 // CV 固定队列中当前正在深挖的经历
  completedExperiences: string[]                  // CV 固定队列中已经深挖完成的经历
  activeDimension: string | null                  // 当前正在被问询的维度
  emptyDimensions: string[]                       // 已确认无相关经历的维度
  progressRevision: number                        // 权威进度的原子更新版本
  step1Summaries: Record<string, string>          // step1 段落摘要（生成一次后持久化）
  quickInfo: { school: string; major: string; gpa: string; targetSchool: string; targetMajor: string; degree: string } | null

  addMessage: (msg: Message) => void
  updateLastAssistantMessage: (content: string, rawContent?: string, metadata?: Pick<Message, 'questionDimension' | 'questionObjective' | 'questionSubject' | 'questionSubjectId' | 'progressEvents'>) => void
  applyInterviewEvents: (events: InterviewProgressEvent[]) => void
  rebuildInterviewProgressFromMessages: () => void
  setInterviewComplete: (v: boolean) => void
  setCvText: (t: string) => void
  setCvAnalysis: (a: string) => void
  setCoveredDimensions: (dims: string[]) => void
  removeFromCovered: (dim: string) => void
  deferDimension: (dim: string) => void
  setDimensionMessageIndex: (dimension: string, index: number) => void
  setTargetProgram: (t: string) => void
  setPersonas: (p: Persona[]) => void
  setSelectedPersona: (p: Persona | null) => void
  setEssayType: (t: EssayType) => void
  setWordLimit: (w: string) => void
  setSchoolNotes: (n: string) => void
  setFrameworkGeneratedWith: (cfg: { essayType: string; wordLimit: string; schoolNotes: string; personaId: string | number } | null) => void
  setFramework: (f: FrameworkSection[]) => void
  setDraft: (d: string) => void
  setDimensionSummary: (dimension: string, summary: string) => void
  setActiveDimension: (dim: string | null) => void
  syncInterviewProgress: (progress: { activeDimension: string | null; coveredDimensions: string[]; emptyDimensions?: string[] }) => void
  markDimensionEmpty: (dim: string) => void
  removeFromEmpty: (dim: string) => void
  setStep1Summary: (dim: string, summary: string) => void
  setExpMessageIndex: (name: string, index: number) => void
  setActiveExperience: (name: string | null) => void
  completeExperience: (name: string) => void
  setQuickInfo: (info: { school: string; major: string; gpa: string; targetSchool: string; targetMajor: string; degree: string } | null) => void
  resetInterview: () => void
  reset: () => void
}

const initialState = {
  interviewProtocolVersion: 2 as const,
  messages: [],
  cvText: '',
  cvAnalysis: '',
  interviewComplete: false,
  coveredDimensions: [],
  deferredDimensions: [],
  targetProgram: '',
  personas: [],
  selectedPersona: null,
  essayType: 'SOP' as EssayType,
  wordLimit: '',
  schoolNotes: '',
  frameworkGeneratedWith: null,
  framework: [],
  draft: '',
  dimensionSummaries: {},
  dimensionMessageIndex: {},
  expMessageIndex: {},
  activeExperience: null,
  completedExperiences: [],
  activeDimension: null,
  emptyDimensions: [],
  progressRevision: 0,
  step1Summaries: {},
  quickInfo: null,
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      ...initialState,

      addMessage: (msg) =>
        set((state) => ({ messages: [...state.messages, {
          ...msg,
          id: msg.id || globalThis.crypto?.randomUUID?.() || `msg-${Date.now()}-${state.messages.length}`,
        }] })),

      updateLastAssistantMessage: (content, rawContent, metadata) =>
        set((state) => {
          const msgs = [...state.messages]
          const lastIdx = msgs.length - 1
          if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
            msgs[lastIdx] = {
              ...msgs[lastIdx],
              content,
              ...(rawContent !== undefined ? { rawContent } : {}),
              ...(metadata?.questionDimension ? { questionDimension: metadata.questionDimension } : {}),
              ...(metadata?.questionObjective ? { questionObjective: metadata.questionObjective } : {}),
              ...(metadata?.questionSubject ? { questionSubject: metadata.questionSubject } : {}),
              ...(metadata?.questionSubjectId ? { questionSubjectId: metadata.questionSubjectId } : {}),
              ...(metadata?.progressEvents ? { progressEvents: metadata.progressEvents } : {}),
            }
          }
          return { messages: msgs }
        }),

      setCvText: (t) => set({ cvText: t }),
      setCvAnalysis: (a) => set({ cvAnalysis: a }),
      setInterviewComplete: (v) => set((state) => state.interviewProtocolVersion === 2 ? state :
        state.interviewComplete === v ? state : { interviewComplete: v }),
      setCoveredDimensions: (dims) => set((state) => {
        if (state.interviewProtocolVersion === 2) return state
        const additions = dims.filter(dim => !state.coveredDimensions.includes(dim))
        return additions.length === 0
          ? state
          : { coveredDimensions: [...state.coveredDimensions, ...additions] }
      }),
      removeFromCovered: (dim) => set((state) => state.interviewProtocolVersion === 2 ? state :
        !state.coveredDimensions.includes(dim)
          ? state
          : { coveredDimensions: state.coveredDimensions.filter(d => d !== dim) }),
      deferDimension: (dim) => set((state) => state.interviewProtocolVersion === 2 ? state :
        state.deferredDimensions.includes(dim)
          ? state
          : { deferredDimensions: [...state.deferredDimensions, dim] }),
      setDimensionMessageIndex: (dimension, index) => set((state) =>
        state.dimensionMessageIndex[dimension] === index
          ? state
          : { dimensionMessageIndex: { ...state.dimensionMessageIndex, [dimension]: index } }),
      setTargetProgram: (t) => set({ targetProgram: t }),
      setPersonas: (p) => set({ personas: p }),
      setSelectedPersona: (p) => set({ selectedPersona: p }),
      setEssayType: (t) => set({ essayType: t }),
      setWordLimit: (w) => set({ wordLimit: w }),
      setSchoolNotes: (n) => set({ schoolNotes: n }),
      setFrameworkGeneratedWith: (cfg) => set({ frameworkGeneratedWith: cfg }),
      setFramework: (f) => set({ framework: f }),
      setDraft: (d) => set({ draft: d }),
      setDimensionSummary: (dimension, summary) =>
        set((state) => ({
          dimensionSummaries: {
            ...state.dimensionSummaries,
            [dimension]: summary,
          },
        })),
      setActiveDimension: (dim) => set((state) => state.interviewProtocolVersion === 2 ? state :
        state.activeDimension === dim ? state : { activeDimension: dim }),
      syncInterviewProgress: ({ activeDimension, coveredDimensions, emptyDimensions }) => set((state) => {
        if (state.interviewProtocolVersion === 2) return state
        const normalized = normalizeInterviewProgress({
          activeDimension,
          coveredDimensions,
          emptyDimensions: emptyDimensions === undefined ? state.emptyDimensions : emptyDimensions,
        })
        const nextCovered = normalized.coveredDimensions
        const nextEmpty = normalized.emptyDimensions
        const coveredUnchanged = nextCovered.length === state.coveredDimensions.length &&
          nextCovered.every(dimension => state.coveredDimensions.includes(dimension))
        const emptyUnchanged = nextEmpty.length === state.emptyDimensions.length &&
          nextEmpty.every(dimension => state.emptyDimensions.includes(dimension))
        if (state.activeDimension === normalized.activeDimension && coveredUnchanged && emptyUnchanged) return state
        return {
          activeDimension: normalized.activeDimension,
          coveredDimensions: nextCovered,
          emptyDimensions: nextEmpty,
          // Persisted sessions created before progressRevision existed hydrate it
          // as undefined, so treat their first authoritative sync as revision 1.
          progressRevision: (state.progressRevision ?? 0) + 1,
        }
      }),
      markDimensionEmpty: (dim) => set((state) => state.interviewProtocolVersion === 2 ? state :
        state.emptyDimensions.includes(dim)
          ? state
          : { emptyDimensions: [...state.emptyDimensions, dim] }),
      removeFromEmpty: (dim) => set((state) => state.interviewProtocolVersion === 2 ? state :
        !state.emptyDimensions.includes(dim)
          ? state
          : { emptyDimensions: state.emptyDimensions.filter(d => d !== dim) }),
      applyInterviewEvents: (events) => set((state) => {
        if (state.interviewProtocolVersion !== 2 || events.length === 0) return state
        const covered = new Set(state.coveredDimensions)
        const empty = new Set(state.emptyDimensions)
        const deferred = new Set(state.deferredDimensions)
        let active = state.activeDimension
        let complete = state.interviewComplete
        const canAdvanceTo = (dimension: string) => {
          const index = INTERVIEW_DIMENSION_ORDER.indexOf(dimension as typeof INTERVIEW_DIMENSION_ORDER[number])
          if (index < 0) return false
          const activeIndex = active
            ? INTERVIEW_DIMENSION_ORDER.indexOf(active as typeof INTERVIEW_DIMENSION_ORDER[number])
            : -1
          if (activeIndex >= 0 && index < activeIndex) return false
          return INTERVIEW_DIMENSION_ORDER.slice(0, index).every(previous =>
            covered.has(previous) || empty.has(previous) || deferred.has(previous))
        }
        for (const event of events) {
          const dim = event.dimension
          if (event.type === 'dimension_started' && dim && canAdvanceTo(dim)) {
            covered.delete(dim)
            empty.delete(dim)
            active = dim
          } else if (event.type === 'dimension_available' && dim) {
            covered.delete(dim)
            empty.delete(dim)
          } else if (event.type === 'dimension_completed' && dim && canAdvanceTo(dim)) {
            covered.add(dim)
            empty.delete(dim)
            if (active === dim) active = null
          } else if (event.type === 'dimension_empty' && dim) {
            empty.add(dim)
            covered.delete(dim)
            if (active === dim) active = null
          } else if (event.type === 'dimension_deferred' && dim) {
            deferred.add(dim)
            if (active === dim) active = null
          } else if (event.type === 'interview_completed') {
            active = null
            complete = true
          }
        }
        const normalized = normalizeInterviewProgress({
          activeDimension: active,
          coveredDimensions: Array.from(covered),
          emptyDimensions: Array.from(empty),
        })
        return {
          ...normalized,
          deferredDimensions: Array.from(deferred),
          interviewComplete: complete,
          progressRevision: (state.progressRevision ?? 0) + 1,
        }
      }),
      rebuildInterviewProgressFromMessages: () => set((state) => {
        if (state.interviewProtocolVersion !== 2) return state
        const covered = new Set<string>()
        const empty = new Set<string>()
        let active: string | null = null
        let complete = false
        const deferred = new Set(state.deferredDimensions)
        const canAdvanceTo = (dimension: string) => {
          const index = INTERVIEW_DIMENSION_ORDER.indexOf(dimension as typeof INTERVIEW_DIMENSION_ORDER[number])
          if (index < 0) return false
          const activeIndex = active
            ? INTERVIEW_DIMENSION_ORDER.indexOf(active as typeof INTERVIEW_DIMENSION_ORDER[number])
            : -1
          if (activeIndex >= 0 && index < activeIndex) return false
          return INTERVIEW_DIMENSION_ORDER.slice(0, index).every(previous =>
            covered.has(previous) || empty.has(previous) || deferred.has(previous))
        }
        const events = state.messages.flatMap(message => message.progressEvents ?? [])
        for (const event of events) {
          const dim = event.dimension
          if (event.type === 'dimension_started' && dim && canAdvanceTo(dim)) {
            covered.delete(dim); empty.delete(dim); active = dim
          } else if (event.type === 'dimension_available' && dim) {
            covered.delete(dim); empty.delete(dim)
          } else if (event.type === 'dimension_completed' && dim && canAdvanceTo(dim)) {
            covered.add(dim); empty.delete(dim); if (active === dim) active = null
          } else if (event.type === 'dimension_empty' && dim) {
            empty.add(dim); covered.delete(dim); if (active === dim) active = null
          } else if (event.type === 'dimension_deferred' && dim) {
            deferred.add(dim)
            if (active === dim) active = null
          } else if (event.type === 'interview_completed') {
            active = null; complete = true
          }
        }
        const normalized = normalizeInterviewProgress({
          activeDimension: active,
          coveredDimensions: Array.from(covered),
          emptyDimensions: Array.from(empty),
        })
        return {
          ...normalized,
          deferredDimensions: Array.from(deferred),
          interviewComplete: complete,
          progressRevision: (state.progressRevision ?? 0) + 1,
        }
      }),
      setStep1Summary: (dim, summary) => set((state) => ({
        step1Summaries: { ...state.step1Summaries, [dim]: summary },
      })),
      setExpMessageIndex: (name, index) => set((state) =>
        state.expMessageIndex[name] === index
          ? state
          : { expMessageIndex: { ...state.expMessageIndex, [name]: index } }),
      setActiveExperience: (name) => set((state) =>
        state.activeExperience === name ? state : { activeExperience: name }),
      completeExperience: (name) => set((state) => {
        const alreadyCompleted = state.completedExperiences.includes(name)
        const shouldClearActive = state.activeExperience === name
        if (alreadyCompleted && !shouldClearActive) return state
        return {
          completedExperiences: alreadyCompleted
            ? state.completedExperiences
            : [...state.completedExperiences, name],
          activeExperience: shouldClearActive ? null : state.activeExperience,
        }
      }),
      setQuickInfo: (info) => set({ quickInfo: info }),

      resetInterview: () => set({
    interviewProtocolVersion: 2,
    messages: [],
    interviewComplete: false,
    coveredDimensions: [],
    deferredDimensions: [],
    targetProgram: '',
    personas: [],
    selectedPersona: null,
    essayType: 'SOP' as EssayType,
    framework: [],
    draft: '',
    dimensionSummaries: {},
    dimensionMessageIndex: {},
    expMessageIndex: {},
    activeExperience: null,
    completedExperiences: [],
    activeDimension: null,
    emptyDimensions: [],
    progressRevision: 0,
    step1Summaries: {},
  }),
  reset: () => set(initialState),
    }),
    {
      name: 'essay-assistant-store',
      version: 2,
      migrate: (persisted: unknown, version) => {
        const state = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>
        if (version < 2) {
          const oldMessages = Array.isArray(state.messages) ? state.messages : []
          return { ...state, interviewProtocolVersion: oldMessages.length > 0 ? 1 : 2 }
        }
        return state
      },
    }
  )
)
