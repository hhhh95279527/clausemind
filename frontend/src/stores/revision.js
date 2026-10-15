// frontend/src/stores/revision.js
// AI 改稿台：修订列表/生成/接受拒绝/重新生成/模拟反驳
import { create } from 'zustand'
import http from '@/utils/http.js'
import { useAuthStore } from './auth.js'
import { useContractStore } from './contract.js'
import { trackReportExported } from '@/utils/analytics.js'

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

  /**
   * 触发浏览器下载修订后合同 Word（带鉴权头，用 blob 跳转）。
   * mode=clean（默认）：已应用采纳修改、无痕迹可直接定稿的修订后新合同；mode=redline：保留 w:ins/w:del 修订痕迹。
   */
  downloadDocx: async (contractId, mode = 'clean') => {
    const resp = await fetch(`/api/contracts/${contractId}/revisions/docx?mode=${mode}`, {
      headers: { Authorization: `Bearer ${useAuthStore.getState().accessToken}` },
    })
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}))
      throw Object.assign(new Error(data.error?.message || '导出失败'), {
        status: resp.status, code: data.error?.code, reason: data.error?.reason,
      })
    }
    const blob = await resp.blob()
    // 导出成功埋点：scene 从合同详情取（本 store 无此字段，取不到不阻塞导出）
    const scene = useContractStore.getState().detail?.contract?.scene
    trackReportExported('revision_docx', scene)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    // 优先用后端下发的文件名（原文档名（修订后）.docx）
    const cd = resp.headers.get('Content-Disposition') || ''
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i)
    const plain = cd.match(/filename="?([^";]+)"?/i)
    a.download = star
      ? decodeURIComponent(star[1])
      : plain
        ? plain[1]
        : '修订稿.docx'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  },
}))
