// frontend/src/components/rag/DocumentList.jsx
// 文档列表：展示已入库的文档，支持删除和分类筛选
import { useState, useEffect } from 'react'
import { App as AntdApp } from 'antd'
import { useKnowledgeStore } from '@/stores/knowledge.js'
import styles from './DocumentList.module.css'

function docIcon(doc) {
  const name = doc.fileName || ''
  if (name.endsWith('.pdf')) return '📄'
  if (name.endsWith('.md')) return '📝'
  return '📃'
}

function formatDate(isoStr) {
  if (!isoStr) return ''
  const d = new Date(isoStr)
  const now = new Date()
  const diff = (now - d) / 1000

  if (diff < 60) return '刚刚'
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前'
  if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前'
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export default function DocumentList() {
  const documents = useKnowledgeStore((s) => s.documents)
  const categories = useKnowledgeStore((s) => s.categories)
  const loadDocuments = useKnowledgeStore((s) => s.loadDocuments)
  const deleteDocument = useKnowledgeStore((s) => s.deleteDocument)
  const scope = useKnowledgeStore((s) => s.scope)
  const currentSessionId = useKnowledgeStore((s) => s.currentSessionId)
  const isPlatform = scope === 'platform'
  // React 19 下 antd 静态方法 Modal.confirm 无法弹框，必须用 App 上下文的 modal
  const { modal } = AntdApp.useApp()

  const [activeCategory, setActiveCategory] = useState('')

  // 切换范围或会话时重置本地分类 tab（每个会话文档独立）
  useEffect(() => { setActiveCategory('') }, [scope, currentSessionId])

  const filteredDocs = !activeCategory
    ? documents
    : documents.filter((d) => d.category === activeCategory)

  function switchCategory(cat) {
    setActiveCategory(cat)
    loadDocuments(cat).catch(() => {})
  }

  function confirmDelete(doc) {
    modal.confirm({
      title: '删除文档',
      content: `确定删除「${doc.title}」？删除后无法恢复。`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        try {
          await deleteDocument(doc.id)
        } catch {}
      },
    })
  }

  return (
    <div className={styles['doc-list-wrapper']}>
      <div className={styles['list-header']}>
        <span className={styles['list-title']}>{isPlatform ? '平台法规库' : '本会话文档'}</span>
        <span className={styles['doc-count']}>{filteredDocs.length} 篇</span>
      </div>

      {/* 分类筛选 */}
      {categories.length > 1 && (
        <div className={styles['category-tabs']}>
          {categories.map((cat) => (
            <button
              key={cat.value}
              className={`${styles['cat-tab']} ${activeCategory === cat.value ? styles.active : ''}`}
              onClick={() => switchCategory(cat.value)}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!filteredDocs.length ? (
        <div className={styles['empty-state']}>
          <div className={styles.icon}>{isPlatform ? '⚖️' : '📭'}</div>
          <div>{isPlatform ? '平台法规库暂无条文' : currentSessionId ? '本会话还没有文档' : '未选择会话'}</div>
          <div className={styles.sub}>
            {isPlatform
              ? '请稍后再来查看'
              : currentSessionId
                ? '在上方上传文档后即可基于文档问答，文档仅本会话可见'
                : '新建或选择一个会话后，可为其上传独立文档'}
          </div>
        </div>
      ) : (
        /* 文档列表 */
        <div className={styles['doc-items']}>
          {filteredDocs.map((doc) => (
            <div key={doc.id} className={styles['doc-item']}>
              <div className={styles['doc-icon']}>{docIcon(doc)}</div>
              <div className={styles['doc-info']}>
                <div className={styles['doc-title']}>{doc.title}</div>
                <div className={styles['doc-meta']}>
                  <span className="tag tag-gray">{doc.category}</span>
                  <span className={styles['meta-item']}>{doc.chunks} 片段</span>
                  <span className={styles['meta-item']}>{doc.chars?.toLocaleString()} 字</span>
                  <span className={styles['meta-item']}>{formatDate(doc.uploadedAt)}</span>
                </div>
                {/* 预览文本 */}
                <div className={styles['doc-preview']}>{doc.preview}</div>
              </div>
              {!isPlatform && (
                <button
                  className={styles['btn-delete']}
                  onClick={() => confirmDelete(doc)}
                  title="删除文档"
                >
                  🗑
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
