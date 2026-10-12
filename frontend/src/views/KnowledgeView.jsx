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
      <SessionSidebar />
      <RagChat />
    </div>
  )
}
