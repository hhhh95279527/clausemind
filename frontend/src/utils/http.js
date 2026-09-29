// frontend/src/utils/http.js
// 统一封装 axios：请求拦截（JWT Token）、响应拦截（401 自动刷新）、错误处理
import axios from 'axios'
import { useAppStore } from '@/stores/app.js'
import { useAuthStore } from '@/stores/auth.js'
import { trackApiError } from '@/utils/analytics.js'

// 创建 axios 实例
const http = axios.create({
  baseURL: '/api',           // 配合 vite proxy，开发时自动转发到 :3000
  timeout: 30000,            // 普通请求 30s 超时
})

// 是否正在刷新 Token
let isRefreshing = false
let refreshSubscribers = []

function onRefreshed(token) {
  refreshSubscribers.forEach(cb => cb(token))
  refreshSubscribers = []
}

function addRefreshSubscriber(cb) {
  refreshSubscribers.push(cb)
}

// ── 请求拦截器：自动附加 JWT Token ────────────────────────────────
http.interceptors.request.use(
  (config) => {
    const { accessToken } = useAuthStore.getState()
    if (accessToken) {
      config.headers.Authorization = `Bearer ${accessToken}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// ── 响应拦截器：401 自动刷新 Token ────────────────────────────────
http.interceptors.response.use(
  (response) => response.data,
  async (error) => {
    const toast = useAppStore.getState().toast
    const originalRequest = error.config

    // 401 且未重试过：尝试刷新 Token
    if (error.response?.status === 401 && !originalRequest._retry) {
      const { refreshToken, logout } = useAuthStore.getState()

      // 没有 refreshToken，直接登出
      if (!refreshToken) {
        logout()
        window.location.href = '/login'
        return Promise.reject(error)
      }

      // 已在刷新中，排队等待
      if (isRefreshing) {
        return new Promise((resolve) => {
          addRefreshSubscriber((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`
            resolve(http(originalRequest))
          })
        })
      }

      originalRequest._retry = true
      isRefreshing = true

      try {
        const res = await axios.post('/api/auth/refresh', { refreshToken })
        const { accessToken: newAccess, refreshToken: newRefresh } = res.data
        useAuthStore.getState().setTokens(newAccess, newRefresh)
        isRefreshing = false
        onRefreshed(newAccess)
        originalRequest.headers.Authorization = `Bearer ${newAccess}`
        return http(originalRequest)
      } catch (refreshError) {
        isRefreshing = false
        logout()
        window.location.href = '/login'
        return Promise.reject(refreshError)
      }
    }

    // 其他错误处理
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      toast.error('请求超时，请稍后重试')
    } else if (error.response) {
      const status = error.response.status
      const msg = error.response.data?.error?.message || error.response.data?.error || '请求失败'

      // 业务页自行处理的错误（如 PLAN_LIMIT 弹付费墙）可在 config.skipErrorToast 静默
      if (error.config?.skipErrorToast) {
        // fall through，不 toast
      } else if (status === 429) {
        toast.warning('请求太频繁，请稍后再试')
      } else if (status >= 500) {
        toast.error('服务器异常，请稍后重试')
      } else {
        toast.error(msg)
      }
    } else {
      toast.error('网络异常，请检查连接')
    }

    // 上报 API 错误（401 已在上方处理完毕，此处均为最终失败；进 analytics_events 便于排查）
    const reqUrl = error.config?.url || ''
    if (error.response) {
      const errMsg = error.response.data?.error?.message || error.response.data?.error || '请求失败'
      trackApiError(reqUrl, error.response.status, String(errMsg))
    } else if (error.code === 'ECONNABORTED') {
      trackApiError(reqUrl, 0, 'timeout')
    } else {
      trackApiError(reqUrl, 0, error.message || 'network error')
    }

    return Promise.reject(error)
  }
)

// ── SSE 流式请求工具 ───────────────────────────────────────────
// 浏览器原生 fetch + ReadableStream，不走 axios
// onToken：每收到一个 token 的回调
// onEvent：收到特定事件（sources、tool_start 等）的回调
// onDone：流结束时的回调
// onError：出错时的回调
export async function fetchStream(url, body, { onToken, onEvent, onDone, onError } = {}) {
  try {
    const { accessToken } = useAuthStore.getState()
    const headers = { 'Content-Type': 'application/json' }
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      // 保留 status/code/reason/blocked，供业务侧识别 PLAN_LIMIT 弹付费墙
      const err = new Error(data.error?.message || data.error || `HTTP ${response.status}`)
      err.status = response.status
      err.code = data.error?.code
      err.reason = data.error?.reason
      err.blocked = data.error?.blocked
      throw err
    }

    const reader  = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer    = ''

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // SSE 格式：event 和 data 之间用 \n\n 分隔
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.trim()) continue

        const lines = part.split('\n')
        let event = 'message'
        let dataStr = ''

        for (const line of lines) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          if (line.startsWith('data: '))  dataStr = line.slice(6)
        }

        if (!dataStr) continue

        let data
        try { data = JSON.parse(dataStr) } catch { continue }

        // 分发事件
        if (event === 'token' && onToken) {
          onToken(data.token || '')
        } else if (event === 'done' && onDone) {
          onDone(data)
        } else if (event === 'error') {
          onError?.(new Error(data.message || '流式请求出错'))
          return
        } else if (onEvent) {
          onEvent(event, data)
        }
      }
    }
  } catch (err) {
    onError?.(err)
  }
}

export default http
