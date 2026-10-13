// frontend/src/views/AdminView.jsx
// 管理后台主页面：用户管理（实装 UsersView），顶部跳转规则/账单/评测独立页
import { useNavigate } from 'react-router-dom'
import { Space } from 'antd'
import UsersView from './admin/UsersView.jsx'
import styles from './AdminView.module.css'

export default function AdminView() {
  const navigate = useNavigate()

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <h1>管理后台</h1>
            <p className={styles.subtitle}>用户管理</p>
          </div>
          <Space>
            <button className={styles.tab} onClick={() => navigate('/admin/rules')}>📏 审查规则</button>
            <button className={styles.tab} onClick={() => navigate('/admin/billing')}>💰 配额账单</button>
            <button className={styles.tab} onClick={() => navigate('/admin/eval')}>📈 离线评测报告</button>
          </Space>
        </div>
      </header>

      <main className={styles.content}>
        <UsersView />
      </main>
    </div>
  )
}
