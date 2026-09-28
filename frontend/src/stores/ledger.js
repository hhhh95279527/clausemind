// frontend/src/stores/ledger.js
// 合同台账（FR-16）：列表/统计、新建/编辑/续签/解除/删除、AI 抽取预填。
import { create } from 'zustand'
import http from '@/utils/http.js'

export const useLedgerStore = create((set, get) => ({
  items: [],
  total: 0,
  stats: null,
  loading: false,
  query: { q: '', filter: 'ALL', page: 1, pageSize: 20 },

  setQuery: (patch) => {
    set({ query: { ...get().query, ...patch, page: patch.page ?? 1 } })
    return get().loadList()
  },

  loadList: async () => {
    const { q, filter, page, pageSize } = get().query
    set({ loading: true })
    try {
      const params = { filter, page, pageSize }
      if (q) params.q = q
      const res = await http.get('/ledger', { params })
      set({ items: res.items || [], total: res.total || 0, stats: res.stats || null })
      return res
    } finally {
      set({ loading: false })
    }
  },

  create: async (payload) => (await http.post('/ledger', payload)).item,
  update: async (id, payload) => (await http.patch(`/ledger/${id}`, payload)).item,
  renew: async (id, payload) => (await http.post(`/ledger/${id}/renew`, payload)).item,
  terminate: async (id) => http.post(`/ledger/${id}/terminate`),
  remove: async (id) => http.delete(`/ledger/${id}`),

  /** AI 从审查合同抽取台账字段；无 Key 后端 409，调用方转入手填 */
  extract: async (contractId) => http.post('/ledger/extract', { contractId }),
}))
