// frontend/src/config/navigation.jsx
// 导航配置：按 persona + role 分组的三套布局壳（Public/Personal/Team + ADMIN 系统管理）
// Phase 0.3 重构：单一 navItems 改为 navGroups；pageMeta 扩展新路由元信息
import {
  MessageOutlined,
  ReadOutlined,
  RobotOutlined,
  BarChartOutlined,
  SolutionOutlined,
  AppstoreOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  HomeOutlined,
  FileAddOutlined,
  FileTextOutlined,
  FolderOutlined,
  BookOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  AuditOutlined,
  TeamOutlined,
  ApiOutlined,
  PlayCircleOutlined,
  LineChartOutlined,
  BellOutlined,
  EditOutlined,
} from '@ant-design/icons'

// ── persona 枚举（与后端 workspaceType 对齐，Phase 1+2 落库后生效）──────────
export const PERSONAS = {
  PERSONAL: 'PERSONAL',
  TEAM: 'TEAM',
}

// ── 公开布局：无侧边栏，仅页脚链接 ──────────────────────────────────────────
export const publicFooterLinks = [
  { path: '/privacy', label: '隐私政策' },
  { path: '/terms',  label: '用户协议' },
]

// ── 个人布局：侧边栏 6 项 ────────────────────────────────────────────────────
export const personalNav = [
  { path: '/home',          icon: HomeOutlined,         label: '工作台' },
  { path: '/new',           icon: FileAddOutlined,      label: '审合同' },
  { path: '/my-contracts',  icon: FileTextOutlined,     label: '我的合同' },
  { path: '/templates',     icon: BookOutlined,         label: '合同范本' },
  { path: '/knowledge',     icon: ReadOutlined,         label: '法规问答' },
  { path: '/me/billing',    icon: CreditCardOutlined,   label: '我的订阅' },
]

// ── 企业布局：侧边栏 9 项 ─────────────────────────────────────────────────────
export const teamNav = [
  { path: '/dashboard',     icon: DashboardOutlined,   label: '合规仪表盘' },
  { path: '/contracts',     icon: SafetyCertificateOutlined, label: '合同审查' },
  { path: '/ledger',        icon: FolderOutlined,       label: '合同台账' },
  { path: '/templates',     icon: BookOutlined,         label: '合同范本' },
  { path: '/knowledge',     icon: ReadOutlined,         label: '法规问答' },
  { path: '/playbook',      icon: PlayCircleOutlined,   label: '审查规则' },
  { path: '/team',          icon: TeamOutlined,         label: '团队席位' },
  { path: '/integrations',  icon: ApiOutlined,          label: '集成中心' },
  { path: '/billing',       icon: CreditCardOutlined,   label: '我的套餐' },
]

// ── 系统管理分组：仅平台 ADMIN 可见，挂在 TeamLayout 底部 ──────────────────
export const systemAdminNav = [
  { path: '/admin',             icon: SettingOutlined,    label: '用户管理',    group: '系统管理' },
  { path: '/admin/rules',       icon: SafetyCertificateOutlined, label: '规则后台', group: '系统管理' },
  { path: '/admin/eval',        icon: LineChartOutlined,  label: '离线评测',    group: '系统管理' },
  { path: '/agent',             icon: RobotOutlined,      label: '任务 Agent',  group: '系统管理' },
  { path: '/monitor/traces',    icon: BarChartOutlined,   label: '调用链路',    group: '系统管理' },
  { path: '/monitor/billing',   icon: CreditCardOutlined, label: '租户账单',    group: '系统管理' },
  { path: '/admin/analytics',   icon: BellOutlined,       label: '埋点漏斗',    group: '系统管理' },
]

// ── 顶部栏页面元信息（覆盖所有路由）──────────────────────────────────────
export const pageMeta = {
  // 公开
  '/':            { title: 'ClauseMind — AI 合同风险审查', icon: AppstoreOutlined, desc: '免费看到真实风险，付费解锁深度建议' },
  '/pricing':     { title: '定价方案',     icon: CreditCardOutlined, desc: '免费 / 个人 / 团队 / 企业 四档' },
  '/login':       { title: '登录',         icon: SolutionOutlined,   desc: '密码 / 邮箱验证码双通道' },
  '/register':    { title: '注册',         icon: SolutionOutlined,   desc: '个人 / 企业双路径分流' },
  '/privacy':     { title: '隐私政策',     icon: SafetyCertificateOutlined, desc: '数据收集范围与保留策略' },
  '/terms':       { title: '用户协议',     icon: SafetyCertificateOutlined, desc: '服务条款与 AI 免责声明' },

  // 个人
  '/home':          { title: '工作台',     icon: HomeOutlined,       desc: '免费额度、场景入口、最近审查' },
  '/new':           { title: '新建审查',   icon: FileAddOutlined,    desc: '场景选择、粘贴或上传合同' },
  '/my-contracts':  { title: '我的合同',   icon: FileTextOutlined,   desc: '审查历史 / 个人条款库 / 关注偏好' },
  '/me/billing':    { title: '我的订阅',   icon: CreditCardOutlined,  desc: '套餐、券包、订单' },
  '/checkout':      { title: '收银台',     icon: CreditCardOutlined,  desc: '模拟支付，立即生效' },

  // 企业
  '/dashboard':     { title: '合规仪表盘', icon: DashboardOutlined,  desc: '统计卡、待办、风险趋势、到期分桶' },
  '/contracts':     { title: '合同审查',   icon: SafetyCertificateOutlined, desc: '双轨审查 + 人工终审 + 审批流' },
  '/ledger':        { title: '合同台账',   icon: FolderOutlined,     desc: '全生命周期：新建 / 续签 / 解除 / 到期预警' },
  '/playbook':      { title: '审查规则',   icon: PlayCircleOutlined, desc: '红线 / 偏好 / 标准库 / 行业包' },
  '/team':          { title: '团队席位',   icon: TeamOutlined,       desc: '成员、角色、席位用量' },
  '/integrations':  { title: '集成中心',   icon: ApiOutlined,         desc: '飞书 Webhook / MCP，其他联系开通' },
  '/billing':       { title: '我的套餐',   icon: CreditCardOutlined,  desc: '团队席位、增购、企业版留资' },

  // 共享
  '/templates':     { title: '合同范本',   icon: BookOutlined,       desc: '劳动 / 租赁 / 劳务 / NDA / 通用' },
  '/knowledge':     { title: '法规问答',   icon: ReadOutlined,       desc: '平台法规问答为主，我的资料次级' },

  // 系统管理（仅 ADMIN）
  '/admin':           { title: '用户管理',     icon: SettingOutlined,    desc: '租户成员、角色、状态' },
  '/admin/rules':     { title: '规则后台',     icon: SafetyCertificateOutlined, desc: 'review_rules 规则 CRUD 与试运行' },
  '/admin/eval':      { title: '离线评测',     icon: LineChartOutlined,  desc: 'precision/recall/F1、recall@k、忠实度' },
  '/admin/billing':   { title: '租户账单',     icon: CreditCardOutlined, desc: '全租户配额、峰谷费用与超额账期' },
  '/admin/analytics': { title: '埋点漏斗',     icon: BellOutlined,       desc: '注册→首审→付费墙→升级→支付' },
  '/agent':           { title: '任务 Agent',  icon: RobotOutlined,      desc: '复杂任务自动拆解，工具调用可视化' },
  '/monitor':         { title: '用量看板',     icon: BarChartOutlined,   desc: 'Token 消耗、费用、缓存命中率' },
  '/monitor/traces':  { title: '调用链路',     icon: BarChartOutlined,   desc: 'LLM/工具/检索 Span 时间轴' },
  '/monitor/billing': { title: '配额与账单',   icon: BarChartOutlined,   desc: '月度配额、峰谷费用、功能占比、超额记录' },

  // 旧路由（重定向目标，保留 meta 防兜底）
  '/chat':          { title: '智能对话',     icon: MessageOutlined,    desc: '已收编为合同助手' },
}

export const fallbackMeta = { title: 'ClauseMind', icon: AppstoreOutlined }

// 动态详情路由（按前缀匹配）
const pageMetaPatterns = [
  { prefix: '/contracts/', meta: { title: '合同审批详情', icon: SafetyCertificateOutlined, desc: '双轨风险、人工终审、意见书' } },
  { prefix: '/review/', meta: { title: '审查结果', icon: FileTextOutlined, desc: '评分、大白话摘要、风险点与追问' } },
  { prefix: '/draft/', meta: { title: 'AI 改稿台', icon: EditOutlined, desc: '红删蓝增、逐条接受、Word 导出' } },
]

/** 按 pathname 解析页面元信息：先精确匹配，再前缀匹配动态路由，最后兜底 */
export function resolvePageMeta(pathname) {
  if (pageMeta[pathname]) return pageMeta[pathname]
  const hit = pageMetaPatterns.find((p) => pathname.startsWith(p.prefix))
  return hit?.meta || fallbackMeta
}

// Logo 图标
export const LogoIcon = SolutionOutlined

// ── 旧路由重定向目标（persona 驱动，App.jsx 调用）─────────────────────────
// /chat、/monitor 等旧路由的重定向目标
export function legacyRouteTarget(persona, path) {
  if (path === '/chat') {
    return persona === PERSONAS.TEAM ? '/dashboard' : '/home'
  }
  if (path === '/monitor') {
    return persona === PERSONAS.TEAM ? '/dashboard' : '/home'
  }
  return null
}
