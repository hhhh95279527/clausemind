// frontend/src/stores/me.js
// 个人空间：权益快照（额度卡/付费墙）、审查偏好、个人条款库
import { create } from 'zustand'
import http from '@/utils/http.js'

export const FOLLOW_RISK_OPTIONS = ['押金', '定金 / 订金', '违约金', '试用期', '社保', '竞业限制', '争议管辖']

export const DEFAULT_PREFS = {
  followRisks: ['押金', '定金 / 订金', '违约金', '试用期'],
  tone: 'RIGOROUS',
  stance: 'LESSEE',
}

export const useMeStore = create((set, get) => ({
  entitlement: null,
  loadingEntitlement: false,
  preferences: null,
  clauseLibrary: [],
  loadingPrefs: false,

  loadEntitlement: async () => {
    set({ loadingEntitlement: true })
    try {
      const data = await http.get('/me/entitlements')
      set({ entitlement: data })
      return data
    } finally {
      set({ loadingEntitlement: false })
    }
  },

  loadPreferences: async () => {
    set({ loadingPrefs: true })
    try {
      const data = await http.get('/me/preferences')
      set({ preferences: data.reviewPrefs, clauseLibrary: data.clauseLibrary || [] })
      return data
    } finally {
      set({ loadingPrefs: false })
    }
  },

  savePreferences: async (prefs) => {
    const data = await http.patch('/me/preferences', prefs)
    set({ preferences: data.reviewPrefs, clauseLibrary: data.clauseLibrary || [] })
    return data
  },

  addClause: async ({ title, content, scene = 'CUSTOM' }) => {
    const data = await http.post('/me/clause-library', { title, content, scene }, { skipErrorToast: true })
    set({ clauseLibrary: data.clauseLibrary || [] })
    return data
  },

  removeClause: async (id) => {
    const data = await http.delete(`/me/clause-library/${id}`)
    set({ clauseLibrary: data.clauseLibrary || [] })
    return data
  },

  /** 是否深度档（个人版及以上） */
  isDeep: () => !!get().entitlement?.features?.deep,
}))
