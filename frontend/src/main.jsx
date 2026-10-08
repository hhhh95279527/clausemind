// frontend/src/main.jsx
// 应用入口：React 19 + React Router + Ant Design 5
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { trackError } from './utils/analytics.js'
import './styles/global.css'

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
)

// 发版后旧页面引用的懒加载分包哈希会失效（ChunkLoadError），表现为登录/跳转卡住、
// 手动刷新才恢复。Vite 在动态 import 失败时派发 vite:preloadError，这里自动刷新一次
// 拿到最新 index.html；用标记位防止异常情况下无限刷新。
const PRELOAD_RELOAD_FLAG = 'wm-preload-reloaded'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault?.()
  if (sessionStorage.getItem(PRELOAD_RELOAD_FLAG)) return
  sessionStorage.setItem(PRELOAD_RELOAD_FLAG, '1')
  window.location.reload()
})
// 正常加载完成后清除标记位，保证下次发版仍能自愈
window.addEventListener('load', () => {
  setTimeout(() => sessionStorage.removeItem(PRELOAD_RELOAD_FLAG), 0)
})

// 全局未捕获异常上报（前端运行时错误进 analytics_events，便于后期排查）
window.addEventListener('error', (e) => {
  trackError(e.error || new Error(e.message || 'window error'), { source: 'window.onerror' })
})
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason))
  trackError(err, { source: 'unhandledrejection' })
})
