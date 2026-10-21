// frontend/src/App.jsx
// 根布局：三套 persona 布局壳（Public/Personal/Team）+ antd ConfigProvider（主题联动）
// Phase 0.3 重构：单一布局壳 → 按 persona 路由分组；旧路由 `/chat` `/monitor` 重定向
import { useEffect, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom'
import { ConfigProvider, App as AntdApp, theme as antdTheme, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import PublicLayout from '@/components/layout/PublicLayout.jsx'
import PersonalLayout from '@/components/layout/PersonalLayout.jsx'
import TeamLayout from '@/components/layout/TeamLayout.jsx'
import AuthGuard from '@/components/common/AuthGuard.jsx'
import { useAppStore, setMessageApi } from '@/stores/app.js'
import { useAuthStore } from '@/stores/auth.js'
import { usePersona } from '@/utils/persona.js'
import { resolvePageMeta, PERSONAS } from '@/config/navigation.jsx'
import { trackPageView } from '@/utils/analytics.js'
import http from '@/utils/http.js'

// ── 已实现的页面（懒加载）─────────────────────────────────────────────────
const LoginView       = lazy(() => import('@/views/LoginView.jsx'))
const RegisterView    = lazy(() => import('@/views/RegisterView.jsx'))
const ForgotPasswordView = lazy(() => import('@/views/ForgotPasswordView.jsx'))
const PrivacyView     = lazy(() => import('@/views/legal/PrivacyView.jsx'))
const TermsView       = lazy(() => import('@/views/legal/TermsView.jsx'))
const LandingView     = lazy(() => import('@/views/public/LandingView.jsx'))
const PricingView     = lazy(() => import('@/views/public/PricingView.jsx'))
const KnowledgeView   = lazy(() => import('@/views/KnowledgeView.jsx'))
const AgentView       = lazy(() => import('@/views/AgentView.jsx'))
const ContractList    = lazy(() => import('@/views/contract/ContractListView.jsx'))
const ReviewWorkbench = lazy(() => import('@/views/contract/ReviewWorkbench.jsx'))

// ── 个人曲线页面已并入企业同构页面（2026-10）：旧路径仅保留重定向 ───────────
const CheckoutView      = lazy(() => import('@/views/personal/CheckoutView.jsx'))

// ── 企业曲线页面（Phase 5 起，Phase 6 补全）────────────────────────────────
const TeamBillingView   = lazy(() => import('@/views/team/TeamBillingView.jsx'))
const PlaybookView      = lazy(() => import('@/views/team/PlaybookView.jsx'))
const LedgerView        = lazy(() => import('@/views/team/LedgerView.jsx'))
const DashboardView     = lazy(() => import('@/views/team/DashboardView.jsx'))
const TeamView          = lazy(() => import('@/views/team/TeamView.jsx'))
const IntegrationsView  = lazy(() => import('@/views/team/IntegrationsView.jsx'))
const TemplatesView     = lazy(() => import('@/views/team/TemplatesView.jsx'))

// ── 个人/企业共享页面 ────────────────────────────────────────────────────────
const FeedbackView      = lazy(() => import('@/views/feedback/FeedbackView.jsx'))

// ── 公开邀请落地页（无需登录，自带全屏布局）──────────────────────────────────
const InviteLandingView = lazy(() => import('@/views/invite/InviteLandingView.jsx'))


// ── 平台超管（独立账号体系，不进主导航，直接访问 URL）───────────────────────
const PlatformConsole   = lazy(() => import('@/views/platform/PlatformConsole.jsx'))

function PageFallback() {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Spin />
    </div>
  )
}

// 旧个人审查详情页（/review/:id、/draft/:id）重定向到合同审查工作台
function ContractRedirect() {
  const { id } = useParams()
  return <Navigate to={`/contracts/${id}`} replace />
}

// 将上下文内的 message 实例注入全局 store，使 toast 跟随动态主题
function MessageBridge() {
  const { message } = AntdApp.useApp()
  useEffect(() => {
    setMessageApi(message)
  }, [message])
  return null
}

export default function App() {
  const theme = useAppStore((s) => s.theme)
  const location = useLocation()
  const isDark = theme === 'dark'
  // persona 由后端 workspaceType 驱动（缺失时 role 兜底），见 utils/persona.js
  const persona = usePersona()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const setUser = useAuthStore((s) => s.setUser)
  const setPaymentEnabled = useAppStore((s) => s.setPaymentEnabled)

  // 公开配置：购买入口总开关（备案审核期间后端置 false，前端隐藏定价/收银台）
  useEffect(() => {
    let alive = true
    http.get('/billing/public-config')
      .then((cfg) => { if (alive && typeof cfg?.paymentEnabled === 'boolean') setPaymentEnabled(cfg.paymentEnabled) })
      .catch(() => { /* 静默：拉取失败保持默认开启，不阻断页面 */ })
    return () => { alive = false }
  }, [setPaymentEnabled])

  // 自愈：进入应用时刷新一次用户资料（含 workspaceType），修复登录后空间类型变化
  // （个人版购买团队版升级 / 转账人工确认到账 / 受邀加入团队）造成的 persona 漂移
  useEffect(() => {
    if (!isAuthenticated) return
    let alive = true
    http.get('/auth/profile')
      .then((profile) => { if (alive && profile?.id) setUser(profile) })
      .catch(() => { /* 静默：token 失效由拦截器统一处理 */ })
    return () => { alive = false }
  }, [isAuthenticated, setUser])

  // 路由切换时更新页面 title + 上报 PV（带来源页 from，供页面跳转/留存分析）
  const prevPathRef = useRef(location.pathname)
  useEffect(() => {
    const meta = resolvePageMeta(location.pathname)
    document.title = `${meta.title} — ClauseMind`
    const from = prevPathRef.current
    trackPageView(location.pathname, from !== location.pathname ? { from } : {})
    prevPathRef.current = location.pathname
  }, [location.pathname])

  // 基于当前 persona 选 authed layout
  const AuthedLayout = persona === PERSONAS.TEAM ? TeamLayout : PersonalLayout

  // 旧路由重定向目标（个人曲线已并入企业同构页面）
  const chatRedirect = '/dashboard'

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: '#4f46e5',
          colorBgBase: isDark ? '#0f1117' : '#ffffff',
        },
      }}
    >
      <AntdApp>
        <MessageBridge />
        <Suspense fallback={<PageFallback />}>
          <Routes location={location}>
            {/* ── 公开页（自带导航/页脚 chrome；落地页对已登录者按 persona 跳转）── */}
            <Route path="/" element={<LandingView />} />
            <Route path="/pricing" element={<PricingView />} />
            {/* LoginView/RegisterView/Legal 页自带满屏布局，不包 PublicLayout */}
            <Route path="/login" element={<LoginView />} />
            <Route path="/register" element={<RegisterView />} />
            <Route path="/forgot-password" element={<ForgotPasswordView />} />
            <Route path="/reset-password" element={<ForgotPasswordView />} />
            <Route path="/privacy" element={<PrivacyView />} />
            <Route path="/terms" element={<TermsView />} />
            {/* 团队邀请落地页（微信/飞书分享链接，公开访问） */}
            <Route path="/invite/:token" element={<InviteLandingView />} />

            {/* ── 认证 + persona 驱动布局 ──────────────────────────────── */}
            {/* 个人曲线已并入企业同构页面：旧路径重定向（/checkout 收银台保留） */}
            <Route path="/home" element={<Navigate to="/dashboard" replace />} />
            <Route path="/new" element={<Navigate to="/contracts" replace />} />
            <Route path="/my-contracts" element={<Navigate to="/contracts" replace />} />
            <Route path="/me/billing" element={<Navigate to="/billing" replace />} />
            <Route path="/review/:id" element={<ContractRedirect />} />
            <Route path="/draft/:id" element={<ContractRedirect />} />
            <Route path="/checkout" element={<AuthGuard><PublicLayout><CheckoutView /></PublicLayout></AuthGuard>} />

            {/* 企业曲线 */}
            <Route path="/dashboard" element={<AuthGuard><AuthedLayout><DashboardView /></AuthedLayout></AuthGuard>} />
            <Route path="/contracts" element={<AuthGuard><AuthedLayout><ContractList /></AuthedLayout></AuthGuard>} />
            <Route path="/contracts/:id" element={<AuthGuard><AuthedLayout><ReviewWorkbench /></AuthedLayout></AuthGuard>} />
            <Route path="/ledger" element={<AuthGuard><AuthedLayout><LedgerView /></AuthedLayout></AuthGuard>} />
            <Route path="/playbook" element={<AuthGuard><AuthedLayout><PlaybookView /></AuthedLayout></AuthGuard>} />
            <Route path="/team" element={<AuthGuard><AuthedLayout><TeamView /></AuthedLayout></AuthGuard>} />
            <Route path="/integrations" element={<AuthGuard><AuthedLayout><IntegrationsView /></AuthedLayout></AuthGuard>} />
            <Route path="/billing" element={<AuthGuard><AuthedLayout><TeamBillingView /></AuthedLayout></AuthGuard>} />

            {/* 共享页面 */}
            <Route path="/templates" element={<AuthGuard><AuthedLayout><TemplatesView /></AuthedLayout></AuthGuard>} />
            <Route path="/knowledge" element={<AuthGuard><AuthedLayout><KnowledgeView /></AuthedLayout></AuthGuard>} />
            <Route path="/feedback" element={<AuthGuard><AuthedLayout><FeedbackView /></AuthedLayout></AuthGuard>} />

            {/* 任务 Agent（个人/企业同构：按 persona 套对应布局壳；平台运维页统一在 /platform） */}
            <Route path="/agent" element={<AuthGuard><AuthedLayout><AgentView /></AuthedLayout></AuthGuard>} />

            {/* ── 旧路由重定向 ─────────────────────────────────────────── */}
            <Route path="/chat" element={<Navigate to={chatRedirect} replace />} />
            <Route path="/monitor" element={<Navigate to={chatRedirect} replace />} />

            {/* ── 平台超管（统一登录入口：在 /login 输入超管账密自动路由）── */}
            <Route path="/platform/login" element={<Navigate to="/login" replace />} />
            <Route path="/platform" element={<PlatformConsole />} />

            {/* 兜底 */}
            <Route path="*" element={<Navigate to={chatRedirect} replace />} />
          </Routes>
        </Suspense>
      </AntdApp>
    </ConfigProvider>
  )
}
