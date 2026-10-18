// frontend/src/config/navigation.jsx
// 导航配置：按 persona + role 分组的三套布局壳（Public/Personal/Team + ADMIN 系统管理）
// Phase 0.3 重构：单一 navItems 改为 navGroups；pageMeta 扩展新路由元信息
import {
  MessageOutlined,
  ReadOutlined,
  RobotOutlined,
  SolutionOutlined,
  AppstoreOutlined,
  SafetyCertificateOutlined,
  FolderOutlined,
  BookOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  TeamOutlined,
  ApiOutlined,
  PlayCircleOutlined,
  BulbOutlined,
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

// ── 个人布局：与企业版同构（共享路由），少合同台账/团队席位/集成中心三项团队专属板块 ──
export const personalNav = [
  { path: '/dashboard',  icon: DashboardOutlined,         label: '合规仪表盘' },
  { path: '/contracts',  icon: SafetyCertificateOutlined, label: '合同审查' },
  { path: '/playbook',   icon: PlayCircleOutlined,        label: '我的规则' },
  { path: '/templates',  icon: BookOutlined,              label: '合同范本' },
  { path: '/knowledge',  icon: ReadOutlined,              label: '法规问答' },
  { path: '/agent',      icon: RobotOutlined,             label: '任务 Agent' },
  { path: '/billing',    icon: CreditCardOutlined,        label: '我的套餐' },
  { path: '/feedback',   icon: BulbOutlined,              label: '建议反馈' },
]

// ── 企业布局：侧边栏（仅业务功能；平台运维工具统一在 /platform 超管控制台）────
export const teamNav = [
  { path: '/dashboard',     icon: DashboardOutlined,   label: '合规仪表盘' },
  { path: '/contracts',     icon: SafetyCertificateOutlined, label: '合同审查' },
  { path: '/ledger',        icon: FolderOutlined,       label: '合同台账' },
  { path: '/templates',     icon: BookOutlined,         label: '合同范本' },
  { path: '/knowledge',     icon: ReadOutlined,         label: '法规问答' },
  { path: '/agent',         icon: RobotOutlined,        label: '任务 Agent' },
  { path: '/playbook',      icon: PlayCircleOutlined,   label: '审查规则' },
  { path: '/team',          icon: TeamOutlined,         label: '团队席位' },
  { path: '/integrations',  icon: ApiOutlined,          label: '集成中心' },
  { path: '/billing',       icon: CreditCardOutlined,   label: '我的套餐' },
  { path: '/feedback',      icon: BulbOutlined,         label: '建议反馈' },
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

  // 个人与企业同构（/dashboard /contracts /ledger /billing 见企业段）

  // 收银台（订阅/券包支付）
  '/checkout':     { title: '收银台',     icon: CreditCardOutlined,  desc: '模拟支付，立即生效' },

  // 企业
  '/dashboard':     { title: '合规仪表盘', icon: DashboardOutlined,  desc: '统计卡、待办、风险趋势、到期分桶' },
  '/contracts':     { title: '合同审查',   icon: SafetyCertificateOutlined, desc: '双轨审查 + 人工终审 + 审批流' },
  '/ledger':        { title: '合同台账',   icon: FolderOutlined,     desc: '全生命周期：新建 / 续签 / 解除 / 到期预警' },
  '/agent':         { title: '任务 Agent', icon: RobotOutlined,      desc: '自然语言任务自动拆解与工具调用可视化' },
  '/playbook':      { title: '我的规则',   icon: PlayCircleOutlined,  desc: '红线 / 偏好 / 行业包' },
  '/team':          { title: '团队席位',   icon: TeamOutlined,       desc: '成员、角色、席位用量' },
  '/integrations':  { title: '集成中心',   icon: ApiOutlined,         desc: '飞书 Webhook / MCP，其他联系开通' },
  '/billing':       { title: '我的套餐',   icon: CreditCardOutlined,  desc: '团队席位、增购、企业版留资' },

  // 共享
  '/templates':     { title: '合同范本',   icon: BookOutlined,       desc: '劳动 / 租赁 / 劳务 / NDA / 通用' },
  '/knowledge':     { title: '法规问答',   icon: ReadOutlined,       desc: '平台法规问答为主，我的资料次级' },
  '/feedback':      { title: '建议反馈',   icon: BulbOutlined,       desc: '功能建议 / 问题反馈 / 体验优化，直达产品团队' },

  // 旧路由（重定向目标，保留 meta 防兜底）
  '/chat':          { title: '智能对话',     icon: MessageOutlined,    desc: '已收编为合同助手' },
}

export const fallbackMeta = { title: 'ClauseMind', icon: AppstoreOutlined }

// 动态详情路由（按前缀匹配）
const pageMetaPatterns = [
  { prefix: '/contracts/', meta: { title: '合同审查工作台', icon: SafetyCertificateOutlined, desc: '双轨风险、人工终审、意见书' } },
]

/** 按 pathname 解析页面元信息：先精确匹配，再前缀匹配动态路由，最后兜底 */
export function resolvePageMeta(pathname) {
  if (pageMeta[pathname]) return pageMeta[pathname]
  const hit = pageMetaPatterns.find((p) => pathname.startsWith(p.prefix))
  return hit?.meta || fallbackMeta
}

// Logo 图标
export const LogoIcon = SolutionOutlined
