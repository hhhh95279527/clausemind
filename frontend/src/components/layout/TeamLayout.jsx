// frontend/src/components/layout/TeamLayout.jsx
// 企业布局壳：侧边栏仅业务菜单（平台运维工具统一在 /platform 超管控制台）
import { teamNav } from '@/config/navigation.jsx'
import AppShell from './AppShell.jsx'

export default function TeamLayout({ children }) {
  return <AppShell items={teamNav}>{children}</AppShell>
}
