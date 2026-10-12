// frontend/src/utils/platformApi.js
// 平台超管专用 API 客户端：与主站 http.js 完全隔离（独立 token、独立 401 处理）
import axios from 'axios'

export const PLATFORM_TOKEN_KEY = 'platform_token'
export const PLATFORM_USER_KEY = 'platform_username'

const platformApi = axios.create({
  baseURL: '/api/platform',
  timeout: 30000,
})

platformApi.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(PLATFORM_TOKEN_KEY)
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  return cfg
})

platformApi.interceptors.response.use(
  (res) => res.data,
  (err) => {
    // 平台 token 失效：清凭证，由页面层跳回登录
    if (err.response?.status === 401) {
      localStorage.removeItem(PLATFORM_TOKEN_KEY)
      localStorage.removeItem(PLATFORM_USER_KEY)
    }
    return Promise.reject(err)
  },
)

export function platformErrMessage(err, fallback = '操作失败，请稍后重试') {
  return err.response?.data?.error?.message || err.response?.data?.message || fallback
}

export default platformApi
