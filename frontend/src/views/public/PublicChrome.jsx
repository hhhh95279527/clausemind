// frontend/src/views/public/PublicChrome.jsx
// 营销公开页骨架：顶部导航 + 内容 + 页脚（落地页 / 定价页共用；无侧边栏）
import { Link } from 'react-router-dom'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import { homePath } from '@/utils/persona.js'
import styles from './PublicChrome.module.css'

export default function PublicChrome({ children }) {
  const user = useAuthStore((s) => s.user)

  return (
    <div className={styles.wrap}>
      <nav className={styles.topnav}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}><SafetyCertificateOutlined /></span>
          WorkMind
        </Link>
        <div className={styles.navLinks}>
          <a href="/#abilities">产品能力</a>
          <Link to="/pricing">定价</Link>
        </div>
        <div className={styles.navActions}>
          {user ? (
            <Link className={styles.btnPrimary} to={homePath(user)}>进入控制台</Link>
          ) : (
            <>
              <Link className={styles.btnGhost} to="/login">登录</Link>
              <Link className={styles.btnPrimary} to="/register">免费注册</Link>
            </>
          )}
        </div>
      </nav>

      <div className={styles.main}>{children}</div>

      <footer className={styles.footer}>
        <p>
          <Link to="/">产品</Link> / <Link to="/pricing">定价</Link> /
          <Link to="/privacy">隐私政策</Link> / <Link to="/terms">用户协议</Link>
        </p>
        <p>AI 仅做风险提示，不构成法律意见，重大合同建议咨询执业律师</p>
      </footer>
    </div>
  )
}
