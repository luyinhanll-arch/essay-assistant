'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Message, Persona, FrameworkSection, EssayType } from './types'

interface AppStore {
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
  framework: FrameworkSection[]
  draft: string
  dimensionSummaries: Record<string, string>      // 维度key -> AI总结
  dimensionMessageIndex: Record<string, number>   // 维度key -> 触发覆盖时的消息index
  activeDimension: string | null                  // 当前正在被问询的维度
  emptyDimensions: string[]                       // 已确认无相关经历的维度
  step1Summaries: Record<string, string>          // step1 段落摘要（生成一次后持久化）

  addMessage: (msg: Message) => void
  updateLastAssistantMessage: (content: string, rawContent?: string) => void
  setInterviewComplete: (v: boolean) => void
  setCvText: (t: string) => void
  setCvAnalysis: (a: string) => void
  setCoveredDimensions: (dims: string[]) => void
  deferDimension: (dim: string) => void
  setDimensionMessageIndex: (dimension: string, index: number) => void
  setTargetProgram: (t: string) => void
  setPersonas: (p: Persona[]) => void
  setSelectedPersona: (p: Persona | null) => void
  setEssayType: (t: EssayType) => void
  setFramework: (f: FrameworkSection[]) => void
  setDraft: (d: string) => void
  setDimensionSummary: (dimension: string, summary: string) => void
  setActiveDimension: (dim: string | null) => void
  markDimensionEmpty: (dim: string) => void
  setStep1Summary: (dim: string, summary: string) => void
  resetInterview: () => void
  reset: () => void
}

const initialState = {
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
  framework: [],
  draft: '',
  dimensionSummaries: {},
  dimensionMessageIndex: {},
  activeDimension: null,
  emptyDimensions: [],
  step1Summaries: {},
}

export const useAppStore = create<AppStore>()(
  persist(
    (set) => ({
      ...initialState,

      addMessage: (msg) =>
        set((state) => ({ messages: [...state.messages, msg] })),

      updateLastAssistantMessage: (content, rawContent) =>
        set((state) => {
          const msgs = [...state.messages]
          const lastIdx = msgs.length - 1
          if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
            msgs[lastIdx] = { ...msgs[lastIdx], content, ...(rawContent !== undefined ? { rawContent } : {}) }
          }
          return { messages: msgs }
        }),

      setCvText: (t) => set({ cvText: t }),
      setCvAnalysis: (a) => set({ cvAnalysis: a }),
      setInterviewComplete: (v) => set({ interviewComplete: v }),
      setCoveredDimensions: (dims) => set((state) => ({
        coveredDimensions: Array.from(new Set([...state.coveredDimensions, ...dims])),
      })),
      deferDimension: (dim) => set((state) => ({
        deferredDimensions: Array.from(new Set([...state.deferredDimensions, dim])),
      })),
      setDimensionMessageIndex: (dimension, index) => set((state) => ({
        dimensionMessageIndex: { ...state.dimensionMessageIndex, [dimension]: index },
      })),
      setTargetProgram: (t) => set({ targetProgram: t }),
      setPersonas: (p) => set({ personas: p }),
      setSelectedPersona: (p) => set({ selectedPersona: p }),
      setEssayType: (t) => set({ essayType: t }),
      setFramework: (f) => set({ framework: f }),
      setDraft: (d) => set({ draft: d }),
      setDimensionSummary: (dimension, summary) =>
        set((state) => ({
          dimensionSummaries: {
            ...state.dimensionSummaries,
            [dimension]: summary,
          },
        })),
      setActiveDimension: (dim) => set({ activeDimension: dim }),
      markDimensionEmpty: (dim) => set((state) => ({
        emptyDimensions: Array.from(new Set([...state.emptyDimensions, dim])),
      })),
      setStep1Summary: (dim, summary) => set((state) => ({
        step1Summaries: { ...state.step1Summaries, [dim]: summary },
      })),

      resetInterview: () => set({
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
    activeDimension: null,
    emptyDimensions: [],
    step1Summaries: {},
  }),
  reset: () => set(initialState),
    }),
    { name: 'essay-assistant-store' }
  )
)
