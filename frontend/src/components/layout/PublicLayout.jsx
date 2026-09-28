// frontend/src/components/layout/PublicLayout.jsx
// 公开布局壳：无侧边栏，仅页脚（隐私政策/用户协议）；落地页/定价/登录/注册/合规页使用
import { Link } from 'react-router-dom'
import { publicFooterLinks } from '@/config/navigation.jsx'

export default function PublicLayout({ children }) {
  return (
    <div className="public-layout" style={{
      display: 'flex',
      flexDirection: 'column',
      minHeight: '100vh',
      background: 'var(--color-bg)',
    }}>
      <main style={{ flex: 1 }}>
        {children}
      </main>
      <footer style={{
        padding: '24px 32px',
        borderTop: '1px solid var(--color-border-light)',
        display: 'flex',
        justifyContent: 'center',
        gap: 24,
        fontSize: 13,
        color: 'var(--color-text-sub)',
      }}>
        <span>© 2026 WorkMind</span>
        {publicFooterLinks.map((l) => (
          <Link key={l.path} to={l.path}>{l.label}</Link>
        ))}
        <span>AI 风险提示不构成法律意见</span>
      </footer>
    </div>
  )
}
