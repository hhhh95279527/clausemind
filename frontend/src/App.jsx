// frontend/src/App.jsx
// 根布局：三套 persona 布局壳（Public/Personal/Team）+ antd ConfigProvider（主题联动）
// Phase 0.3 重构：单一布局壳 → 按 persona 路由分组；旧路由 `/chat` `/monitor` 重定向
import { useEffect, lazy, Suspense } from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { ConfigProvider, App as AntdApp, theme as antdTheme, Spin } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import PublicLayout from '@/components/layout/PublicLayout.jsx'
import PersonalLayout from '@/components/layout/PersonalLayout.jsx'
import TeamLayout from '@/components/layout/TeamLayout.jsx'
import AuthGuard from '@/components/common/AuthGuard.jsx'
import PagePlaceholder from '@/components/common/PagePlaceholder.jsx'
import { useAppStore, setMessageApi } from '@/stores/app.js'
import { usePersona } from '@/utils/persona.js'
import { resolvePageMeta, PERSONAS } from '@/config/navigation.jsx'

// ── 已实现的页面（懒加载）─────────────────────────────────────────────────
const LoginView       = lazy(() => import('@/views/LoginView.jsx'))
const RegisterView    = lazy(() => import('@/views/RegisterView.jsx'))
const PrivacyView     = lazy(() => import('@/views/legal/PrivacyView.jsx'))
const TermsView       = lazy(() => import('@/views/legal/TermsView.jsx'))
const LandingView     = lazy(() => import('@/views/public/LandingView.jsx'))
const PricingView     = lazy(() => import('@/views/public/PricingView.jsx'))
const ChatView        = lazy(() => import('@/views/ChatView.jsx'))
const KnowledgeView   = lazy(() => import('@/views/KnowledgeView.jsx'))
const AgentView       = lazy(() => import('@/views/AgentView.jsx'))
const ContractList    = lazy(() => import('@/views/contract/ContractListView.jsx'))
const ReviewWorkbench = lazy(() => import('@/views/contract/ReviewWorkbench.jsx'))
const MonitorView     = lazy(() => import('@/views/MonitorView.jsx'))
const TraceWaterfall  = lazy(() => import('@/views/monitor/TraceWaterfall.jsx'))
const BillingView     = lazy(() => import('@/views/monitor/BillingView.jsx'))
const AdminView       = lazy(() => import('@/views/AdminView.jsx'))
const EvalView        = lazy(() => import('@/views/admin/EvalView.jsx'))
const RuleAdminView   = lazy(() => import('@/views/admin/RuleAdminView.jsx'))

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

// ── 占位页面（后续 Phase 实现后替换）──────────────────────────────────────
const AnalyticsView     = () => <PagePlaceholder title="埋点漏斗"     phase="Phase 7" desc="注册→首审→付费墙→升级→支付" />

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

  // 路由切换时更新页面 title
  useEffect(() => {
    const meta = resolvePageMeta(location.pathname)
    document.title = `${meta.title} — WorkMind`
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
            <Route path="/privacy" element={<PrivacyView />} />
            <Route path="/terms" element={<TermsView />} />

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

            {/* 系统管理（仅 ADMIN 可见，强制 TeamLayout，导航条目由 systemAdminNav 控制） */}
            <Route path="/admin" element={<AuthGuard><TeamLayout><AdminView /></TeamLayout></AuthGuard>} />
            <Route path="/admin/eval" element={<AuthGuard><TeamLayout><EvalView /></TeamLayout></AuthGuard>} />
            <Route path="/admin/billing" element={<AuthGuard><TeamLayout><BillingView /></TeamLayout></AuthGuard>} />
            <Route path="/admin/rules" element={<AuthGuard><TeamLayout><RuleAdminView /></TeamLayout></AuthGuard>} />
            <Route path="/admin/analytics" element={<AuthGuard><TeamLayout><AnalyticsView /></TeamLayout></AuthGuard>} />
            <Route path="/agent" element={<AuthGuard><TeamLayout><AgentView /></TeamLayout></AuthGuard>} />
            <Route path="/monitor/traces" element={<AuthGuard><TeamLayout><TraceWaterfall /></TeamLayout></AuthGuard>} />
            <Route path="/monitor/billing" element={<AuthGuard><TeamLayout><BillingView /></TeamLayout></AuthGuard>} />

            {/* ── 旧路由重定向 ─────────────────────────────────────────── */}
            <Route path="/chat" element={<Navigate to={chatRedirect} replace />} />
            <Route path="/monitor" element={<Navigate to={chatRedirect} replace />} />

            {/* 兜底 */}
            <Route path="*" element={<Navigate to={chatRedirect} replace />} />
          </Routes>
        </Suspense>
      </AntdApp>
    </ConfigProvider>
  )
}
