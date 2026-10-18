// frontend/src/views/KnowledgeView.jsx
// 法规问答页面：左 文档面板（我的文档/平台法规库）｜会话列表｜RAG 问答
import { useEffect } from 'react'
import { useKnowledgeStore } from '@/stores/knowledge.js'
import DocumentUploader from '@/components/rag/DocumentUploader.jsx'
import DocumentList from '@/components/rag/DocumentList.jsx'
import SessionSidebar from '@/components/rag/SessionSidebar.jsx'
import RagChat from '@/components/rag/RagChat.jsx'
import styles from './KnowledgeView.module.css'

export default function KnowledgeView() {
  const sessions = useKnowledgeStore((s) => s.sessions)
  const currentSessionId = useKnowledgeStore((s) => s.currentSessionId)
  const querying = useKnowledgeStore((s) => s.querying)
  const newSession = useKnowledgeStore((s) => s.newSession)
  const selectSession = useKnowledgeStore((s) => s.selectSession)
  const removeSession = useKnowledgeStore((s) => s.removeSession)

  useEffect(() => {
    const kn = useKnowledgeStore.getState()
    // 仅加载会话列表；文档面板默认"我的文档 + 无会话"，严格为空，
    // 只有进入某会话后才加载该会话自己上传的文档（会话间隔离）
    kn.loadSessions()
  }, [])

  return (
    <div className={styles['knowledge-view']}>
      <aside className={styles['doc-panel']}>
        <DocumentUploader />
        <div className={styles.divider} />
        <DocumentList />
      </aside>
      <SessionSidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        busy={querying}
        onNew={newSession}
        onSelect={selectSession}
        onDelete={removeSession}
        deleteConfirm={{
          title: '删除会话',
          content: '确定删除会话「{title}」？该会话的问答记录及其中上传的文档将一并删除且无法恢复。',
        }}
      />
      <RagChat />
    </div>
  )
}
