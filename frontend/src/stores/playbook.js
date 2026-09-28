// frontend/src/stores/playbook.js
// Playbook 企业审查规则（FR-17）：红线/偏好规则 CRUD、AI 转草稿、样例试命中、行业包。
import { create } from 'zustand'
import http from '@/utils/http.js'

export const usePlaybookStore = create((set, get) => ({
  rules: [],
  packs: [],
  loading: false,

  loadAll: async () => {
    set({ loading: true })
    try {
      const [rulesRes, packsRes] = await Promise.all([
        http.get('/playbook/rules'),
        http.get('/playbook/packs'),
      ])
      set({ rules: rulesRes.rules || [], packs: packsRes.packs || [] })
    } finally {
      set({ loading: false })
    }
  },

  createRule: async (payload) => {
    const res = await http.post('/playbook/rules', payload)
    set({ rules: [res.rule, ...get().rules] })
    return res.rule
  },

  updateRule: async (id, payload) => {
    const res = await http.patch(`/playbook/rules/${id}`, payload)
    set({ rules: get().rules.map((r) => (r.id === id ? res.rule : r)) })
    return res.rule
  },

  toggleRule: async (id, enabled) => {
    const res = await http.patch(`/playbook/rules/${id}/toggle`, { enabled })
    set({ rules: get().rules.map((r) => (r.id === id ? res.rule : r)) })
    return res.rule
  },

  deleteRule: async (id) => {
    await http.delete(`/playbook/rules/${id}`)
    set({ rules: get().rules.filter((r) => r.id !== id) })
  },

  /** 自然语言 → 结构化草稿；无 Key 后端 409，调用方引导手写 */
  parseRule: async (naturalPrompt, contractTypes) =>
    http.post('/playbook/rules/parse', { naturalPrompt, contractTypes }),

  /** 样例条款本地试命中（不耗模型） */
  testRule: async (pattern, samples) =>
    http.post('/playbook/rules/test', { pattern, samples }),

  enablePack: async (code) => {
    const res = await http.post(`/playbook/packs/${code}/enable`)
    const packsRes = await http.get('/playbook/packs')
    set({ packs: packsRes.packs || [] })
    await get().loadAll()
    return res
  },
}))
