// frontend/src/components/rag/SessionSidebar.jsx
// 会话列表（纯展示组件）：新建 / 切换 / 删除；数据与动作由调用方注入
// 使用方：法规问答 KnowledgeView（knowledge store）、任务 Agent AgentView（agent store）
import { App as AntdApp } from 'antd'
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

export default function SessionSidebar({
  sessions = [],
  currentSessionId = null,
  busy = false,            // 执行中禁用新建/切换/删除，防竞态
  onNew,
  onSelect,
  onDelete,
  icon = '💬',
  newHint = '开始一轮全新的问答会话',
  emptyHint = '暂无历史会话',
  emptySub = '点击上方「新建会话」开始',
  deleteConfirm = { title: '删除会话', content: '确定删除该会话？记录将一并删除且无法恢复。' },
}) {
  // React 19 下 antd 静态方法 Modal.confirm 无法弹框，必须用 App 上下文的 modal
  const { modal } = AntdApp.useApp()

  function confirmDelete(e, session) {
    e.stopPropagation()
    if (busy) return // 执行中禁止删除，防当前会话落库 404
    modal.confirm({
      title: deleteConfirm.title,
      content: deleteConfirm.content.replace('{title}', session.title || '新会话'),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => onDelete?.(session.id)?.catch?.(() => {}),
    })
  }

  return (
    <div className={styles['session-rail']}>
      <button
        className={styles['btn-new']}
        onClick={() => onNew?.()?.catch?.(() => {})}
        disabled={busy}
        title={newHint}
      >
        <span className={styles['plus']}>＋</span> 新建会话
      </button>

      <div className={styles['rail-title']}>历史会话</div>

      {!sessions.length ? (
        <div className={styles['rail-empty']}>
          {emptyHint}
          <div className={styles['rail-sub']}>{emptySub}</div>
        </div>
      ) : (
        <div className={styles['session-items']}>
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`${styles['session-item']} ${s.id === currentSessionId ? styles.active : ''}`}
              onClick={() => !busy && onSelect?.(s.id)?.catch?.(() => {})}
            >
              <div className={styles['session-icon']}>{icon}</div>
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
