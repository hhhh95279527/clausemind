// frontend/src/stores/tenant-template.js
// 企业自有合同范本库（团队空间）：列表 / 上传（XHR，同步提取全文）/ 删除 / AI 提炼 / 导入规则
import { create } from 'zustand'
import http from '@/utils/http.js'
import { useAuthStore } from '@/stores/auth.js'

export const useTenantTemplateStore = create((set, get) => ({
  templates: [],
  limit: 30,
  loading: false,
  uploading: false,

  load: async () => {
    set({ loading: true })
    try {
      const data = await http.get('/tenant-templates')
      set({ templates: data.templates || [], limit: data.limit || 30 })
    } finally {
      set({ loading: false })
    }
  },

  // 上传范本：服务端同步提取全文（数秒），XHR 错误体与拦截器格式对齐
  upload: async (file, title) => {
    const formData = new FormData()
    formData.append('file', file)
    if (title) formData.append('title', title)
    set({ uploading: true })
    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', '/api/tenant-templates/upload')
        xhr.setRequestHeader('Authorization', `Bearer ${useAuthStore.getState().accessToken}`)
        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
          else reject(new Error(JSON.parse(xhr.responseText)?.error?.message || '上传失败'))
        })
        xhr.addEventListener('error', () => reject(new Error('网络错误')))
        xhr.send(formData)
      })
      await get().load()
      return result.template
    } finally {
      set({ uploading: false })
    }
  },

  detail: async (id) => http.get(`/tenant-templates/${id}`),

  // 在线编辑：只改标题/正文（原始文件不动），返回更新后的列表项并就地替换
  update: async (id, payload) => {
    const data = await http.patch(`/tenant-templates/${id}`, payload)
    set((s) => ({ templates: s.templates.map((t) => (t.id === id ? { ...t, ...data.template } : t)) }))
    return data.template
  },

  remove: async (id) => {
    await http.delete(`/tenant-templates/${id}`)
    set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
  },

  // AI 提炼候选规则（不落库；10~30 秒）
  extractRules: (id, focus) =>
    http.post(`/tenant-templates/${id}/extract-rules`, { focus: focus || '' }, { timeout: 120_000 }),

  // 人工勾选/编辑后的候选批量导入（source=AI）
  importRules: (templateId, rules) =>
    http.post('/playbook/rules/import', { templateId, rules }),
}))
