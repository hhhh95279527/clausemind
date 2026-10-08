// frontend/src/components/layout/AppSidebar.jsx
// 左侧导航栏：Logo + 7个模块菜单 + 底部主题切换
import { NavLink, useLocation } from 'react-router-dom'
import { SunOutlined, MoonOutlined } from '@ant-design/icons'
import { navItems, LogoIcon } from '@/config/navigation.jsx'
import { useAppStore } from '@/stores/app.js'
import styles from './AppSidebar.module.css'

export default function AppSidebar() {
  const location = useLocation()
  const theme = useAppStore((s) => s.theme)
  const toggleTheme = useAppStore((s) => s.toggleTheme)
  const isDark = theme === 'dark'

  return (
    <aside className={styles.sidebar}>
      {/* Logo 区域 */}
      <div className={styles['sidebar-logo']}>
        <LogoIcon className={styles['logo-icon']} />
        <span className={styles['logo-text']}>ClauseMind</span>
      </div>

      {/* 主菜单 */}
      <nav className={styles['sidebar-nav']}>
        {navItems.map((item) => {
          const Icon = item.icon
          return (
            <NavLink
              key={item.path}
              to={item.path}
              className={`${styles['nav-item']} ${location.pathname.startsWith(item.path) ? styles.active : ''}`}
            >
              <Icon className={styles['nav-icon']} />
              <span className={styles['nav-label']}>{item.label}</span>
              {/* 新功能角标 */}
              {item.badge && <span className={styles['nav-badge']}>{item.badge}</span>}
            </NavLink>
          )
        })}
      </nav>

      {/* 底部：主题切换 + 版本号 */}
      <div className={styles['sidebar-footer']}>
        <button
          className={styles['theme-toggle']}
          onClick={toggleTheme}
          title={isDark ? '切换浅色' : '切换深色'}
        >
          {isDark ? <SunOutlined /> : <MoonOutlined />}
          <span>{isDark ? '浅色模式' : '深色模式'}</span>
        </button>
        <div className={styles.version}>v1.0.0</div>
      </div>
    </aside>
  )
}
