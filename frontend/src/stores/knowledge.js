// frontend/src/stores/knowledge.js
// 知识库模块状态：文档范围（我的文档/平台法规库）、多会话管理、文档上传、问答
import { create } from 'zustand'
import http, { fetchStream } from '@/utils/http.js'
import { useAppStore } from './app.js'
import { useAuthStore } from './auth.js'

let msgId = 0

// 无会话/空分类时的默认下拉项
const DEFAULT_CATEGORIES = [{ value: '', label: '全部文档' }]

export const useKnowledgeStore = create((set, get) => {
  // 局部更新某条问答消息
  const patchMsg = (id, patchFn) => set((s) => ({
    messages: s.messages.map((m) => m.id === id ? { ...m, ...patchFn(m) } : m),
  }))

  return {
    // ── 文档范围 ───────────────────────────────────────────────
    // mine：仅当前用户上传的私有文档（默认，问答只基于这些文档）
    // platform：平台维护的共享法规库（只读）
    scope: 'mine',
    documents: [],
    categories: DEFAULT_CATEGORIES,
    uploading: false,
    uploadProgress: 0,  // 0-100

    setScope: async (scope) => {
      if (scope === get().scope) return
      set({ scope, filterCategory: '' })
      await Promise.all([get().loadDocuments(), get().loadCategories()])
    },

    // 文档严格按"范围 + 当前会话"加载：
    // - 我的文档：只加载当前会话上传的文档；无会话时直接为空，绝不展示其他会话的文档
    // - 平台法规库：加载平台共享的 6 部法规（与会话无关）
    loadDocuments: async (category = '') => {
      const scope = get().scope
      const params = new URLSearchParams({ scope })
      if (category) params.set('category', category)
      if (scope === 'mine') {
        const sessionId = get().currentSessionId
        if (!sessionId) {
          set({ documents: [] })
          return
        }
        params.set('sessionId', sessionId)
      }
      const data = await http.get(`/knowledge/documents?${params}`)
      set({ documents: data.documents })
    },

    loadCategories: async () => {
      const scope = get().scope
      if (scope === 'mine' && !get().currentSessionId) {
        set({ categories: DEFAULT_CATEGORIES })
        return
      }
      const params = new URLSearchParams({ scope })
      if (scope === 'mine') params.set('sessionId', get().currentSessionId)
      const data = await http.get(`/knowledge/categories?${params}`)
      set({ categories: data.categories })
    },

    // 上传文件（归入当前会话的"我的文档"，会话间隔离）
    uploadFile: async (file, { title, category }) => {
      const sessionId = get().currentSessionId
      if (!sessionId) {
        useAppStore.getState().toast.error('请先新建会话后再上传文档')
        throw new Error('no session')
      }
      set({ uploading: true, uploadProgress: 0 })

      const formData = new FormData()
      formData.append('file', file)
      formData.append('title', title || file.name.replace(/\.[^.]+$/, ''))
      formData.append('category', category || '通用')
      formData.append('sessionId', sessionId)

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

        // 上传后确保停留在"我的文档"并刷新
        set({ scope: 'mine' })
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

    // 上传纯文本内容（归入当前会话）
    uploadText: async ({ title, category, content }) => {
      const sessionId = get().currentSessionId
      if (!sessionId) {
        useAppStore.getState().toast.error('请先新建会话后再上传文档')
        throw new Error('no session')
      }
      set({ uploading: true })
      try {
        const data = await http.post('/knowledge/documents', { title, category, content, sessionId })
        set({ scope: 'mine' })
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

    // ── 会话管理（每会话独立历史，持久化在后端）─────────────────
    sessions: [],
    currentSessionId: null,
    messages: [],
    querying: false,
    filterCategory: '',

    setFilterCategory: (cat) => set({ filterCategory: cat }),

    loadSessions: async () => {
      const data = await http.get('/knowledge/sessions')
      set({ sessions: data.sessions })
    },

    // 新建会话并切换（不立即落库则首轮提问时由后端隐式创建；这里先建保证列表即时反馈）
    newSession: async () => {
      if (get().querying) return
      const data = await http.post('/knowledge/sessions', {})
      set((s) => ({
        sessions: [data.session, ...s.sessions],
        currentSessionId: data.session.id,
        messages: [],
        filterCategory: '',
        // 切到全新会话：我的文档面板必须清空，不沿用上一会话的文档
        ...(s.scope === 'mine' ? { documents: [], categories: DEFAULT_CATEGORIES } : {}),
      }))
      return data.session.id
    },

    // 切换会话：懒加载历史消息（含来源片段）+ 该会话自己的文档列表
    selectSession: async (sessionId) => {
      if (!sessionId || sessionId === get().currentSessionId || get().querying) return
      const data = await http.get(`/knowledge/sessions/${sessionId}`)
      set({
        currentSessionId: data.session.id,
        messages: data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          time: m.time,
          sources: m.sources || [],
        })),
        filterCategory: '',
      })
      // 我的文档范围：加载目标会话的文档；平台法规库全局共享，无需重载
      if (get().scope === 'mine') {
        await Promise.all([get().loadDocuments(), get().loadCategories()])
      }
    },

    removeSession: async (sessionId) => {
      await http.delete(`/knowledge/sessions/${sessionId}`)
      set((s) => {
        const rest = s.sessions.filter((x) => x.id !== sessionId)
        const wasCurrent = s.currentSessionId === sessionId
        return {
          sessions: rest,
          currentSessionId: wasCurrent ? null : s.currentSessionId,
          messages: wasCurrent ? [] : s.messages,
          ...(wasCurrent && s.scope === 'mine'
            ? { documents: [], categories: DEFAULT_CATEGORIES, filterCategory: '' }
            : {}),
        }
      })
    },

    // ── RAG 问答（自动绑定当前会话；平台库无会话时由后端隐式创建）──
    query: async (question) => {
      if (!question.trim() || get().querying) return
      // 我的文档必须在会话内提问（文档随会话隔离）：防御性兜底，正常流程 UI 已拦截
      if (get().scope === 'mine' && !get().currentSessionId) {
        await get().newSession()
      }
      set({ querying: true })

      const scope = get().scope
      const sessionId = get().currentSessionId
      const userMsg = { id: `local_${++msgId}`, role: 'user', content: question, time: new Date().toISOString() }
      const aiId = `local_${++msgId}`
      const aiMsg = {
        id: aiId,
        role: 'assistant',
        content: '',
        sources: [],
        status: '正在检索相关文档...',
        streaming: true,
      }
      set((s) => ({ messages: [...s.messages, userMsg, aiMsg] }))

      let boundSessionId = sessionId
      await fetchStream(
        '/api/knowledge/query/stream',
        {
          question,
          scope,
          category: get().filterCategory || undefined,
          ...(sessionId ? { sessionId } : {}),
        },
        {
          onEvent: (event, data) => {
            if (event === 'session') {
              boundSessionId = data.sessionId
              set((s) => ({
                currentSessionId: data.sessionId,
                sessions: s.sessions.some((x) => x.id === data.sessionId)
                  ? s.sessions
                  : [{ id: data.sessionId, title: data.title, updatedAt: new Date().toISOString() }, ...s.sessions],
              }))
            }
            if (event === 'sources') patchMsg(aiId, () => ({ sources: data.sources }))
            if (event === 'status')  patchMsg(aiId, () => ({ status: data.message }))
          },
          onToken: (token) => {
            patchMsg(aiId, (m) => ({ content: m.content + token, status: '' }))
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

      // 刷新会话列表（标题/排序更新）
      if (boundSessionId) {
        get().loadSessions().catch(() => {})
      }
      set({ querying: false })
    },
  }
})
