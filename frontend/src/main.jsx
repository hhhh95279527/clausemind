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

// 全局未捕获异常上报（前端运行时错误进 analytics_events，便于后期排查）
window.addEventListener('error', (e) => {
  trackError(e.error || new Error(e.message || 'window error'), { source: 'window.onerror' })
})
window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason))
  trackError(err, { source: 'unhandledrejection' })
})
