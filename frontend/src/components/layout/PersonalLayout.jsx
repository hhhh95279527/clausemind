// frontend/src/components/layout/PersonalLayout.jsx
// 个人布局壳：侧边栏 6 项 + 顶部栏；persona=PERSONAL 时使用
import { personalNav } from '@/config/navigation.jsx'
import AppShell from './AppShell.jsx'

export default function PersonalLayout({ children }) {
  // 个人布局无系统管理分组，差异仅在导航数据；外壳见 AppShell
  return <AppShell items={personalNav}>{children}</AppShell>
}
