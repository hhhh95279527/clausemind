// frontend/src/components/rag/DocumentUploader.jsx
// 文档上传：拖拽上传 + 点击上传 + 粘贴文本
import { useState, useRef } from 'react'
import { useKnowledgeStore } from '@/stores/knowledge.js'
import styles from './DocumentUploader.module.css'

const CATEGORY_OPTIONS = ['通用', '技术文档', 'HR 制度', '产品手册', '法律合规', '业务流程']

export default function DocumentUploader() {
  const uploading = useKnowledgeStore((s) => s.uploading)
  const uploadProgress = useKnowledgeStore((s) => s.uploadProgress)
  const uploadFile = useKnowledgeStore((s) => s.uploadFile)
  const uploadText = useKnowledgeStore((s) => s.uploadText)
  const scope = useKnowledgeStore((s) => s.scope)
  const currentSessionId = useKnowledgeStore((s) => s.currentSessionId)

  const [showTextInput, setShowTextInput] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState(null)
  const [form, setForm] = useState({ title: '', category: '通用', content: '' })
  const fileInput = useRef(null)

  const ext = selectedFile?.name?.split('.').pop()?.toLowerCase()
  const fileIcon = ext === 'pdf' ? '📄' : ext === 'docx' ? '📘' : ext === 'md' ? '📝' : '📃'

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / 1024 / 1024).toFixed(1) + ' MB'
  }

  function onDrop(e) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) setFile(file)
  }

  function onFileChange(e) {
    const file = e.target.files[0]
    if (file) setFile(file)
  }

  function setFile(file) {
    setSelectedFile(file)
    setForm((f) => f.title ? f : { ...f, title: file.name.replace(/\.[^.]+$/, '') })
  }

  function clearFile() {
    setSelectedFile(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  async function doUpload() {
    if (!selectedFile) return
    try {
      await uploadFile(selectedFile, { title: form.title, category: form.category })
    } catch {}
    clearFile()
    setForm((f) => ({ ...f, title: '' }))
  }

  async function doUploadText() {
    if (!form.title.trim() || !form.content.trim()) return
    try {
      await uploadText({ title: form.title, category: form.category, content: form.content })
      setForm({ title: '', category: '通用', content: '' })
    } catch {}
  }

  const categorySelect = (
    <select
      className="input select"
      value={form.category}
      onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
    >
      {CATEGORY_OPTIONS.map((c) => (
        <option key={c} value={c}>{c}</option>
      ))}
    </select>
  )

  // 平台法规库为平台维护的共享只读内容，不提供上传入口
  if (scope === 'platform') {
    return (
      <div className={styles['uploader-wrapper']}>
        <div className={styles['section-header']}>
          <h3 className={styles['section-title']}>平台法规库</h3>
        </div>
        <div style={{ padding: '4px 2px 12px', fontSize: 12, lineHeight: 1.7, color: 'var(--color-text-muted)' }}>
          ⚖️ 此处为平台整理并持续更新的法律法规条文库，所有用户可检索提问，<b>不可上传或删除</b>。
          如需基于自己的文档问答，请切换顶部「📂 我的文档」后上传。
        </div>
      </div>
    )
  }

  // 我的文档：必须先选定/新建会话。文档按会话隔离，无会话时不展示上传入口
  if (!currentSessionId) {
    return (
      <div className={styles['uploader-wrapper']}>
        <div className={styles['section-header']}>
          <h3 className={styles['section-title']}>添加文档</h3>
        </div>
        <div style={{ padding: '4px 2px 12px', fontSize: 12, lineHeight: 1.8, color: 'var(--color-text-muted)' }}>
          💬 请先在中间栏点击 <b>「＋ 新建会话」</b> 或选择一个历史会话。
          <br />
          每轮会话上传的文档<b>相互独立</b>：仅在当前会话中可见、可问答；新建会话后需重新上传，删除会话时其文档一并删除。
        </div>
      </div>
    )
  }

  return (
    <div className={styles['uploader-wrapper']}>
      {/* 标题栏 */}
      <div className={styles['section-header']}>
        <h3 className={styles['section-title']}>添加文档</h3>
        <button className={styles['btn-text']} onClick={() => setShowTextInput(!showTextInput)}>
          {showTextInput ? '← 上传文件' : '粘贴文本 →'}
        </button>
      </div>

      {/* 方式一：文件上传 */}
      {!showTextInput ? (
        <div>
          <div
            className={[
              styles['drop-zone'],
              isDragging ? styles['drag-over'] : '',
              selectedFile ? styles['has-file'] : '',
            ].join(' ')}
            onDragOver={(e) => {
              e.preventDefault()
              setIsDragging(true)
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInput.current?.click()}
          >
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.pdf,.docx"
              hidden
              onChange={onFileChange}
            />

            {/* 未选择文件 */}
            {!selectedFile ? (
              <div className={styles['drop-hint']}>
                <div className={styles['drop-icon']}>📂</div>
                <div className={styles['drop-text']}>拖拽文件到此处，或点击选择</div>
                <div className={styles['drop-sub']}>支持 .txt、.md、.pdf、.docx，免费版 8MB / 会员 15MB</div>
              </div>
            ) : (
              /* 已选择文件 */
              <div className={styles['file-preview']}>
                <div className={styles['file-icon']}>{fileIcon}</div>
                <div className={styles['file-info']}>
                  <div className={styles['file-name']}>{selectedFile.name}</div>
                  <div className={styles['file-size']}>{formatSize(selectedFile.size)}</div>
                </div>
                <button
                  className={styles['btn-remove']}
                  onClick={(e) => {
                    e.stopPropagation()
                    clearFile()
                  }}
                >×</button>
              </div>
            )}
          </div>

          {/* 标题和分类 */}
          <div className={styles['form-row']}>
            <input
              className="input"
              style={{ flex: 1 }}
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="文档标题（可选，默认用文件名）"
            />
            {categorySelect}
          </div>

          {/* 上传进度 */}
          {uploading && (
            <div className={styles['progress-bar']}>
              <div className={styles['progress-fill']} style={{ width: uploadProgress + '%' }} />
              <span className={styles['progress-text']}>
                {uploadProgress < 80 ? '上传中...' : '向量化处理中...'}
              </span>
            </div>
          )}

          <button
            className="btn btn-primary upload-btn"
            style={{ width: '100%', justifyContent: 'center', marginTop: 'var(--space-sm)' }}
            onClick={doUpload}
            disabled={!selectedFile || uploading}
          >
            {uploading ? '处理中...' : '📥 上传入库'}
          </button>
        </div>
      ) : (
        /* 方式二：粘贴文本 */
        <div className={styles['text-input-form']}>
          <input
            className="input"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="文档标题（必填）"
          />
          {categorySelect}
          <textarea
            className="input textarea"
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            placeholder="在此粘贴文档内容..."
            rows={6}
          />
          <div className={styles['char-hint']}>{form.content.length} 字</div>
          <button
            className="btn btn-primary upload-btn"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={doUploadText}
            disabled={!form.title.trim() || !form.content.trim() || uploading}
          >
            {uploading ? '处理中...' : '📥 添加入库'}
          </button>
        </div>
      )}
    </div>
  )
}
