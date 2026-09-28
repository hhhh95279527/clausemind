// frontend/src/stores/revision.js
// AI 改稿台：修订列表/生成/接受拒绝/重新生成/模拟反驳
import { create } from 'zustand'
import http from '@/utils/http.js'
import { useAuthStore } from './auth.js'

export const REVISION_STATUS_META = {
  NONE: { text: '未生成', color: 'default' },
  PENDING: { text: '待确认', color: 'orange' },
  ACCEPTED: { text: '已接受', color: 'green' },
  REJECTED: { text: '已拒绝', color: 'default' },
}

export const useRevisionStore = create((set) => ({
  data: null,
  loading: false,
  acting: false,

  load: async (contractId) => {
    set({ loading: true })
    try {
      const data = await http.get(`/contracts/${contractId}/revisions`)
      set({ data })
      return data
    } finally {
      set({ loading: false })
    }
  },

  generate: async (contractId, force = false) => {
    set({ acting: true })
    try {
      const data = await http.post(`/contracts/${contractId}/revisions/generate`, { force })
      set({ data })
      return data
    } finally {
      set({ acting: false })
    }
  },

  setStatus: async (contractId, riskId, status) => {
    await http.post(`/risks/${riskId}/revision`, { status })
    return useRevisionStore.getState().load(contractId)
  },

  acceptAll: async (contractId) => {
    await http.post(`/contracts/${contractId}/revisions/accept-all`)
    return useRevisionStore.getState().load(contractId)
  },

  regenerate: async (contractId, riskId, tone = 'NEUTRAL') => {
    await http.post(`/risks/${riskId}/revision/regenerate`, { tone })
    return useRevisionStore.getState().load(contractId)
  },

  rebuttal: async (riskId) => (await http.post(`/risks/${riskId}/revision/rebuttal`)).text,

  /** 触发浏览器下载 Word 红划线修订稿（带鉴权头，用 blob 跳转） */
  downloadDocx: async (contractId) => {
    const resp = await fetch(`/api/contracts/${contractId}/revisions/docx`, {
      headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken}` },
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw Object.assign(new Error(data.error?.message || '导出失败'), {
        status: resp.status, code: data.error?.code, reason: data.error?.reason,
      })
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `修订稿.docx`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },

  reset: () => set({ data: null }),
}))
