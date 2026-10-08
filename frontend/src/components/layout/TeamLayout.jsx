// frontend/src/components/layout/TeamLayout.jsx
// 企业布局壳：侧边栏 9 项 + 系统管理分组（仅平台 ADMIN 可见）+ 顶部栏
import { useEffect } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { SunOutlined, MoonOutlined, LogoutOutlined, UserOutlined, MenuOutlined } from '@ant-design/icons'
import { Dropdown } from 'antd'
import {
  teamNav, systemAdminNav, LogoIcon, pageMeta, fallbackMeta,
} from '@/config/navigation.jsx'
import { useAppStore } from '@/stores/app.js'
import { useAuthStore } from '@/stores/auth.js'
import { useMonitorStore } from '@/stores/monitor.js'
import OnboardingGuide from '@/components/onboarding/OnboardingGuide.jsx'
import NotificationBell from './NotificationBell.jsx'
import ScrollArrows from './ScrollArrows.jsx'
import styles from './LayoutSidebar.module.css'

export default function TeamLayout({ children }) {
  const location = useLocation()
  const navigate = useNavigate()
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const sidebarOpen = useAppStore((s) => s.sidebarOpen)
  const setSidebarOpen = useAppStore((s) => s.setSidebarOpen)
  const isDark = theme === 'dark'
  const user = useAuthStore((s) => s.user)
  const logout = useAuthStore((s) => s.logout)
  const hasRole = useAuthStore((s) => s.hasRole)
  const budgetAlert = useMonitorStore((s) => s.budgetWarning())
  // 仅平台 ADMIN 可见系统管理分组；按需扩展为团队 ADMIN
  const canSeeSystem = hasRole('ADMIN')

  // 路由切换后自动收起移动端抽屉
  useEffect(() => {
    setSidebarOpen(false)
  }, [location.pathname, setSidebarOpen])

  const currentMeta =
    pageMeta[location.pathname] ||
    pageMeta[Object.keys(pageMeta).find((k) => location.pathname.startsWith(k))] ||
    fallbackMeta
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
    <div className="app-layout" data-theme={theme}>
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ''}`}>
        <div className={styles['sidebar-logo']}>
          <LogoIcon className={styles['logo-icon']} />
          <span className={styles['logo-text']}>ClauseMind</span>
        </div>
        <nav className={styles['sidebar-nav']}>
          {teamNav.map((item) => {
            const Icon = item.icon
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className={`${styles['nav-item']} ${location.pathname.startsWith(item.path) ? styles.active : ''}`}
              >
                <Icon className={styles['nav-icon']} />
                <span className={styles['nav-label']}>{item.label}</span>
                {item.badge && <span className={styles['nav-badge']}>{item.badge}</span>}
              </NavLink>
            )
          })}

          {canSeeSystem && (
            <>
              <div className={styles['nav-group-title']}>系统管理</div>
              {systemAdminNav.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink
                    key={item.path}
                    to={item.path}
                    className={`${styles['nav-item']} ${location.pathname.startsWith(item.path) ? styles.active : ''}`}
                  >
                    <Icon className={styles['nav-icon']} />
                    <span className={styles['nav-label']}>{item.label}</span>
                  </NavLink>
                )
              })}
            </>
          )}
        </nav>
        <div className={styles['sidebar-footer']}>
          <button
            className={styles['theme-toggle']}
            onClick={toggleTheme}
            title={isDark ? '切换浅色' : '切换深色'}
          >
            {isDark ? <SunOutlined /> : <MoonOutlined />}
            <span>{isDark ? '浅色模式' : '深色模式'}</span>
          </button>
          <div className={styles.version}>v2.0.0</div>
        </div>
      </aside>

      {/* 移动端抽屉遮罩：点击关闭 */}
      {sidebarOpen && (
        <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
      )}

      <div className="main-area">
        <header className="app-header" style={{
          height: 'var(--header-height)',
          padding: '0 24px',
          borderBottom: '1px solid var(--color-border-light)',
          background: 'var(--color-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            {/* 汉堡按钮：仅 ≤768 显示（CSS 控制） */}
            <button
              className="menu-toggle"
              aria-label="打开菜单"
              onClick={() => setSidebarOpen(true)}
            >
              <MenuOutlined />
            </button>
            <PageIcon />
            <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>{currentMeta.title}</h1>
            {currentMeta.desc && (
              <span className="header-desc" style={{ color: 'var(--color-text-sub)', fontSize: 13 }}>{currentMeta.desc}</span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {budgetAlert && (
              <div style={{ color: 'var(--color-warning)', fontSize: 13 }}>
                <span>⚠</span> 今日用量已达 {budgetAlert}
              </div>
            )}
            <NotificationBell />
            <Dropdown menu={userMenu} placement="bottomRight">
              <div style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: 'var(--color-primary)', color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 600,
                }}>{avatarText}</div>
                <span className="header-username" style={{ fontSize: 13 }}>{displayName}</span>
              </div>
            </Dropdown>
          </div>
        </header>
        <main className="page-content">
          {children}
        </main>
      </div>
      <OnboardingGuide />
      {/* 桌面端右侧上下滚动箭头（≤768 自动隐藏） */}
      <ScrollArrows />
    </div>
  )
}
