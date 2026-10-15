// frontend/src/App.jsx
// 根布局：三套 persona 布局壳（Public/Personal/Team）+ antd ConfigProvider（主题联动）
// Phase 0.3 重构：单一布局壳 → 按 persona 路由分组；旧路由 `/chat` `/monitor` 重定向
import { useEffect, useRef, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ConfigProvider, App as AntdApp, theme as antdTheme, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import PublicLayout from '@/components/layout/PublicLayout.jsx'
import PersonalLayout from '@/components/layout/PersonalLayout.jsx'
import TeamLayout from '@/components/layout/TeamLayout.jsx'
import AuthGuard from '@/components/common/AuthGuard.jsx'
import { useAppStore, setMessageApi } from '@/stores/app.js'
import { usePersona } from '@/utils/persona.js'
import { resolvePageMeta, PERSONAS } from '@/config/navigation.jsx'
import { trackPageView } from '@/utils/analytics.js'

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

// ── 个人曲线页面（Phase 4）──────────────────────────────────────────────────
const HomeView          = lazy(() => import('@/views/personal/HomeView.jsx'))
const NewReviewView     = lazy(() => import('@/views/personal/NewReviewView.jsx'))
const ReviewResultView  = lazy(() => import('@/views/personal/ReviewResultView.jsx'))
const MyContractsView   = lazy(() => import('@/views/personal/MyContractsView.jsx'))
const DraftView         = lazy(() => import('@/views/personal/DraftView.jsx'))
const PersonalBillingView = lazy(() => import('@/views/personal/PersonalBillingView.jsx'))
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

  // 旧路由重定向目标
  const chatRedirect = persona === PERSONAS.TEAM ? '/dashboard' : '/home'

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
            {/* 个人曲线 */}
            <Route path="/home" element={<AuthGuard><AuthedLayout><HomeView /></AuthedLayout></AuthGuard>} />
            <Route path="/new" element={<AuthGuard><AuthedLayout><NewReviewView /></AuthedLayout></AuthGuard>} />
            <Route path="/my-contracts" element={<AuthGuard><AuthedLayout><MyContractsView /></AuthedLayout></AuthGuard>} />
            <Route path="/review/:id" element={<AuthGuard><AuthedLayout><ReviewResultView /></AuthedLayout></AuthGuard>} />
            <Route path="/draft/:id" element={<AuthGuard><AuthedLayout><DraftView /></AuthedLayout></AuthGuard>} />
            <Route path="/me/billing" element={<AuthGuard><AuthedLayout><PersonalBillingView /></AuthedLayout></AuthGuard>} />
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

            {/* 任务 Agent（企业业务工具，强制 TeamLayout；平台运维页统一在 /platform） */}
            <Route path="/agent" element={<AuthGuard><TeamLayout><AgentView /></TeamLayout></AuthGuard>} />

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
