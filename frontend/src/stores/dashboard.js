// frontend/src/stores/dashboard.js
// 企业合规仪表盘聚合（FR-15）
import { create } from 'zustand'
import http from '@/utils/http.js'
import { useAppStore } from './app.js'

export const useDashboardStore = create((set) => ({
  data: null,
  loading: false,

  loadSummary: async () => {
    set({ loading: true })
    try {
      const data = await http.get('/dashboard/summary')
      set({ data })
    } catch {
      useAppStore.getState().toast?.error?.('仪表盘数据加载失败')
    } finally {
      set({ loading: false })
    }
  },
}))
