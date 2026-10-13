// frontend/src/stores/me.js
// 个人空间：权益快照（额度卡/付费墙）、审查偏好、个人条款库
import { create } from 'zustand'
import http from '@/utils/http.js'

export const FOLLOW_RISK_OPTIONS = ['押金', '定金 / 订金', '违约金', '试用期', '社保', '竞业限制', '争议管辖']

export const useMeStore = create((set) => ({
  entitlement: null,
  preferences: null,
  clauseLibrary: [],

  loadEntitlement: async () => {
    const data = await http.get('/me/entitlements')
    set({ entitlement: data })
    return data
  },

  loadPreferences: async () => {
    const data = await http.get('/me/preferences')
    set({ preferences: data.reviewPrefs, clauseLibrary: data.clauseLibrary || [] })
    return data
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
}))
