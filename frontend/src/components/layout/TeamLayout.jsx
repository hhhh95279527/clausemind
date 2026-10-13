// frontend/src/components/layout/TeamLayout.jsx
// 企业布局壳：侧边栏 9 项 + 系统管理分组（仅平台 ADMIN 可见）+ 顶部栏
import { teamNav, systemAdminNav } from '@/config/navigation.jsx'
import AppShell from './AppShell.jsx'

export default function TeamLayout({ children }) {
  // systemItems 存在时，AppShell 内部按平台 ADMIN 角色决定是否渲染系统管理分组
  return <AppShell items={teamNav} systemItems={systemAdminNav}>{children}</AppShell>
}
