// frontend/src/components/layout/AppHeader.jsx
// 顶部栏：当前页面标题 + 全局提示 + 用户菜单
import { useLocation, useNavigate } from 'react-router-dom'
import { WarningOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons'
import { Dropdown } from 'antd'
import { resolvePageMeta } from '@/config/navigation.jsx'
import { useMonitorStore } from '@/stores/monitor.js'
import { useAuthStore } from '@/stores/auth.js'
import NotificationBell from './NotificationBell.jsx'
import styles from './AppHeader.module.css'

export default function AppHeader() {
  const location = useLocation()
  const navigate = useNavigate()
  // 预算预警（超过日预算 80% 时显示）
  const budgetAlert = useMonitorStore((s) => s.budgetWarning())
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)

  const currentMeta = resolvePageMeta(location.pathname)
  const PageIcon = currentMeta.icon

  const displayName = user?.displayName || user?.username || '用户'
  const avatarText = displayName.slice(0, 1).toUpperCase()

  const userMenu = {
    items: [
      { key: 'name', icon: <UserOutlined />, label: <span>{user?.username}</span>, disabled: true },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'logout') {
        logout()
        navigate('/login', { replace: true })
      }
    },
  }

  return (
    <header className={styles['app-header']}>
      {/* 左：页面标题 */}
      <div className={styles['header-left']}>
        <h1 className={styles['page-title']}>
          <PageIcon className={styles['page-icon']} />
          {currentMeta.title}
        </h1>
        {currentMeta.desc && <span className={styles['page-desc']}>{currentMeta.desc}</span>}
      </div>

      {/* 右：通知 + 用户 */}
      <div className={styles['header-right']}>
        {/* 预算预警（超出预算时出现） */}
        {budgetAlert && (
          <div className={styles['budget-alert']}>
            <WarningOutlined /> 今日用量已达 {budgetAlert}，请注意控制
          </div>
        )}

        {/* 站内通知铃铛 */}
        <NotificationBell />

        {/* 用户菜单 */}
        <Dropdown menu={userMenu} placement="bottomRight">
          <div className={styles['user-info']} style={{ cursor: 'pointer' }}>
            <div className={styles['user-avatar']}>{avatarText}</div>
            <span className={styles['user-name']}>{displayName}</span>
          </div>
        </Dropdown>
      </div>
    </header>
  )
}
