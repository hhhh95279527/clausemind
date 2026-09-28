// frontend/src/stores/knowledge.js
// 知识库模块状态：文档列表、上传、问答
import { create } from 'zustand'
import http, { fetchStream } from '@/utils/http.js'
import { useAppStore } from './app.js'
import { useAuthStore } from './auth.js'

let msgId = 0

export const useKnowledgeStore = create((set, get) => {
  // 局部更新某条问答消息
  const patchMsg = (id, patchFn) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, ...patchFn(m) } : m),
  }))

  return {
    // ── 文档管理 ───────────────────────────────────────────────
    documents: [],
    categories: [],
    uploading: false,
    uploadProgress: 0,  // 0-100

    loadDocuments: async (category = '') => {
      const params = category ? `?category=${category}` : ''
      const data = await http.get(`/knowledge/documents${params}`)
      set({ documents: data.documents })
    },

    loadCategories: async () => {
      const data = await http.get('/knowledge/categories')
      set({ categories: data.categories })
    },

    // 上传文件
    uploadFile: async (file, { title, category }) => {
      set({ uploading: true, uploadProgress: 0 })

      const formData = new FormData()
      formData.append('file', file)
      formData.append('title', title || file.name.replace(/\.[^.]+$/, ''))
      formData.append('category', category || '通用')

      try {
        // 用原生 XMLHttpRequest 监听上传进度；
        // 注意：XHR 不走 axios 拦截器，必须手动带上与 http.js 一致的 Authorization 头
        const sendXhr = (token) => new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', '/api/knowledge/documents')
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

          xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
              set({ uploadProgress: Math.round((e.loaded / e.total) * 80) })
            }
          })

          xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              set({ uploadProgress: 100 })
              resolve(JSON.parse(xhr.responseText))
            } else {
              const err = new Error(
                JSON.parse(xhr.responseText)?.error?.message || '上传失败'
              )
              err.status = xhr.status
              reject(err)
            }
          })

          xhr.addEventListener('error', () => reject(new Error('网络错误')))
          xhr.send(formData)
        })

        let result
        try {
          result = await sendXhr(useAuthStore.getState().accessToken)
        } catch (err) {
          // access token 过期：用 refresh token 换新后重发一次（与 axios 响应拦截器同策略）
          if (err.status !== 401) throw err
          const { refreshToken, setTokens } = useAuthStore.getState()
          if (!refreshToken) throw err
          const data = await http.post('/auth/refresh', { refreshToken })
          setTokens(data.accessToken, data.refreshToken)
          result = await sendXhr(data.accessToken)
        }

        await get().loadDocuments()
        await get().loadCategories()
        useAppStore.getState().toast.success(`「${result.document.title}」已成功入库，共 ${result.document.chunks} 个片段`)
        return result.document
      } catch (err) {
        useAppStore.getState().toast.error(err.message || '上传失败')
        throw err
      } finally {
        set({ uploading: false, uploadProgress: 0 })
      }
    },

    // 上传纯文本内容
    uploadText: async ({ title, category, content }) => {
      set({ uploading: true })
      try {
        const data = await http.post('/knowledge/documents', { title, category, content })
        await get().loadDocuments()
        await get().loadCategories()
        useAppStore.getState().toast.success(`「${data.document.title}」已成功入库`)
        return data.document
      } catch (err) {
        useAppStore.getState().toast.error('入库失败：' + (err.message || '未知错误'))
        throw err
      } finally {
        set({ uploading: false })
      }
    },

    deleteDocument: async (docId) => {
      const doc = get().documents.find((d) => d.id === docId)
      await http.delete(`/knowledge/documents/${docId}`)
      set((s) => ({ documents: s.documents.filter((d) => d.id !== docId) }))
      useAppStore.getState().toast.success(`「${doc?.title}」已删除`)
    },

    // ── RAG 问答 ───────────────────────────────────────────────
    messages: [],   // 问答历史
    querying: false,
    filterCategory: '',

    setFilterCategory: (cat) => set({ filterCategory: cat }),

    query: async (question) => {
      if (!question.trim() || get().querying) return
      set({ querying: true })

      const userMsg = { id: ++msgId, role: 'user', content: question, time: new Date().toISOString() }
      const aiId = ++msgId
      const aiMsg = {
        id: aiId,
        role: 'assistant',
        content: '',
        sources: [],
        status: '正在检索相关文档...',
        streaming: true,
      }
      set((s) => ({ messages: [...s.messages, userMsg, aiMsg] }))

      await fetchStream(
        '/api/knowledge/query/stream',
        { question, category: get().filterCategory || undefined },
        {
          onToken: (token) => {
            patchMsg(aiId, (m) => ({ content: m.content + token, status: '' }))
          },
          onEvent: (event, data) => {
            if (event === 'sources') patchMsg(aiId, () => ({ sources: data.sources }))
            if (event === 'status')  patchMsg(aiId, () => ({ status: data.message }))
          },
          onDone: () => {
            patchMsg(aiId, () => ({ streaming: false, status: '' }))
          },
          onError: (err) => {
            patchMsg(aiId, (m) => ({
              streaming: false,
              status: '',
              content: m.content || '查询失败，请重试。',
            }))
            useAppStore.getState().toast.error(err.message)
          },
        }
      )

      set({ querying: false })
    },

    clearMessages: () => set({ messages: [] }),
  }
})
