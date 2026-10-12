// frontend/src/components/rag/SessionSidebar.jsx
// 法规问答会话列表：新建会话 / 切换 / 删除；每轮会话历史相互隔离、持久化在后端
import { App as AntdApp } from 'antd'
import { useKnowledgeStore } from '@/stores/knowledge.js'
import styles from './SessionSidebar.module.css'

function relTime(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
  if (diff < 86400 * 2) return '昨天'
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export default function SessionSidebar() {
  const sessions = useKnowledgeStore((s) => s.sessions)
  const currentSessionId = useKnowledgeStore((s) => s.currentSessionId)
  const querying = useKnowledgeStore((s) => s.querying)
  const newSession = useKnowledgeStore((s) => s.newSession)
  const selectSession = useKnowledgeStore((s) => s.selectSession)
  const removeSession = useKnowledgeStore((s) => s.removeSession)
  // React 19 下 antd 静态方法 Modal.confirm 无法弹框，必须用 App 上下文的 modal
  const { modal } = AntdApp.useApp()

  function confirmDelete(e, session) {
    e.stopPropagation()
    modal.confirm({
      title: '删除会话',
      content: `确定删除会话「${session.title}」？该会话的问答记录及其中上传的文档将一并删除且无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => removeSession(session.id).catch(() => {}),
    })
  }

  return (
    <div className={styles['session-rail']}>
      <button
        className={styles['btn-new']}
        onClick={() => newSession().catch(() => {})}
        disabled={querying}
        title="开始一轮全新的问答会话"
      >
        <span className={styles['plus']}>＋</span> 新建会话
      </button>

      <div className={styles['rail-title']}>历史会话</div>

      {!sessions.length ? (
        <div className={styles['rail-empty']}>
          暂无历史会话
          <div className={styles['rail-sub']}>点击上方「新建会话」开始一轮隔离问答</div>
        </div>
      ) : (
        <div className={styles['session-items']}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles['session-item']} ${s.id === currentSessionId ? styles.active : ''}`}
              onClick={() => selectSession(s.id).catch(() => {})}
            >
              <div className={styles['session-icon']}>💬</div>
              <div className={styles['session-main']}>
                <div className={styles['session-title']}>{s.title || '新会话'}</div>
                <div className={styles['session-time']}>{relTime(s.updatedAt)}</div>
              </div>
              <button
                className={styles['btn-del']}
                title="删除会话"
                onClick={(e) => confirmDelete(e, s)}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
