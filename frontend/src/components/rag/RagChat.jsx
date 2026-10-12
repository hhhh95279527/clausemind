// frontend/src/components/rag/RagChat.jsx
// RAG 问答界面：带来源标注的多轮对话，支持"我的文档 / 平台法规库"范围切换
import { useState, useRef, useEffect, useMemo } from 'react'
import { renderMarkdown } from '@/utils/markdown.js'
import { useKnowledgeStore } from '@/stores/knowledge.js'
import styles from './RagChat.module.css'

const EXAMPLE_QUESTIONS = {
  mine: [
    '请总结一下我上传的文档要点',
    '我的文档里对请假是怎么规定的？',
    '文档中提到的关键数据有哪些？',
  ],
  platform: [
    '试用期最长可以约定几个月？',
    '竞业限制的期限和补偿标准是什么？',
    '合同定金的法律上限是多少？',
  ],
}

export default function RagChat() {
  const messages = useKnowledgeStore((s) => s.messages)
  const querying = useKnowledgeStore((s) => s.querying)
  const categories = useKnowledgeStore((s) => s.categories)
  const filterCategory = useKnowledgeStore((s) => s.filterCategory)
  const setFilterCategory = useKnowledgeStore((s) => s.setFilterCategory)
  const query = useKnowledgeStore((s) => s.query)

  const scope = useKnowledgeStore((s) => s.scope)
  const setScope = useKnowledgeStore((s) => s.setScope)
  const documents = useKnowledgeStore((s) => s.documents)
  const currentSessionId = useKnowledgeStore((s) => s.currentSessionId)
  const newSession = useKnowledgeStore((s) => s.newSession)

  const [question, setQuestion] = useState('')
  const [focused, setFocused] = useState(false)
  const [expandedSources, setExpandedSources] = useState({})
  const bottomEl = useRef(null)
  const textareaEl = useRef(null)

  const isMine = scope === 'mine'
  const hasOwnDocs = documents.length > 0
  // "我的文档"范围下：未选会话先引导新建会话；已在会话但未上传文档则引导上传
  const needSession = isMine && !currentSessionId
  const needUpload = isMine && !!currentSessionId && !hasOwnDocs

  async function send() {
    const q = question.trim()
    if (!q || querying || needUpload || needSession) return
    setQuestion('')
    resetHeight()
    await query(q)
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function autoResize() {
    const el = textareaEl.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'
  }

  function resetHeight() {
    if (textareaEl.current) textareaEl.current.style.height = 'auto'
  }

  function toggleSource(msgId, idx) {
    const key = `${msgId}_${idx}`
    setExpandedSources((s) => ({ ...s, [key]: !s[key] }))
  }

  // 新消息自动滚底
  useEffect(() => {
    bottomEl.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length])

  // 流式内容也滚底
  const lastContent = messages[messages.length - 1]?.content
  useEffect(() => {
    if (querying) {
      bottomEl.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [lastContent, querying])

  const examples = EXAMPLE_QUESTIONS[scope] || EXAMPLE_QUESTIONS.mine

  return (
    <div className={styles['rag-chat']}>
      {/* 顶部：范围切换 + 分类过滤 + 新会话 */}
      <div className={styles['filter-bar']}>
        <div className={styles['scope-tabs']} role="tablist">
          <button
            className={`${styles['scope-tab']} ${isMine ? styles.active : ''}`}
            onClick={() => setScope('mine')}
            title="仅检索你自己上传的文档"
          >
            📂 我的文档
          </button>
          <button
            className={`${styles['scope-tab']} ${!isMine ? styles.active : ''}`}
            onClick={() => setScope('platform')}
            title="平台整理的共享法律法规库"
          >
            ⚖️ 平台法规库
          </button>
        </div>

        <select
          className={`input ${styles['filter-select']}`}
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          title="按分类缩小检索范围"
        >
          {categories.map((cat) => (
            <option key={cat.value} value={cat.value}>{cat.label}</option>
          ))}
        </select>

        <button
          className="btn btn-ghost btn-sm"
          onClick={() => newSession().catch(() => {})}
          disabled={querying}
          title="开始一轮全新的会话，与当前会话相互隔离"
        >
          ＋ 新会话
        </button>
      </div>

      {/* 当前会话提示 */}
      <div className={styles['session-hint']}>
        {currentSessionId
          ? '当前会话的文档与问答独立保存，可在中间栏切换其他会话'
          : '尚未选择会话：基于我的文档提问请先新建会话；平台法规库可直接提问'}
      </div>

      {/* 消息列表 */}
      <div className={styles['message-list']}>
        {/* 空状态 */}
        {!messages.length && (
          <div className={styles['empty-state']}>
            {needSession ? (
              <>
                <div className={styles.icon}>💬</div>
                <div className={styles.title}>新建一轮会话开始问答</div>
                <div className={styles.desc}>
                  每轮会话的文档和问答记录相互隔离。点击下方按钮（或中间栏「＋ 新建会话」）开始，
                  之后在左侧上传的文档仅属于该会话。
                </div>
                <div>
                  <button
                    className="btn btn-primary"
                    style={{ marginTop: 4 }}
                    onClick={() => newSession().catch(() => {})}
                  >
                    ＋ 新建会话
                  </button>
                </div>
                <div className={styles['scope-switch-tip']}>
                  也可以切换到顶部「⚖️ 平台法规库」，无需上传直接咨询法律法规。
                </div>
              </>
            ) : needUpload ? (
              <>
                <div className={styles.icon}>📭</div>
                <div className={styles.title}>本会话还没有可问答的文档</div>
                <div className={styles.desc}>
                  法规问答仅基于本会话上传的文档。请先在左侧上传文档（支持 .txt / .md / .pdf / .docx），上传后即可在此提问；其他会话看不到这些文档。
                </div>
                <div className={styles['scope-switch-tip']}>
                  也可以切换到顶部「⚖️ 平台法规库」，直接咨询平台整理的法律法规。
                </div>
              </>
            ) : (
              <>
                <div className={styles.icon}>{isMine ? '🔍' : '⚖️'}</div>
                <div className={styles.title}>
                  {isMine ? '基于我的文档提问' : '咨询平台法规库'}
                </div>
                <div className={styles.desc}>
                  {isMine
                    ? 'AI 只会检索你上传的文档，给出带来源标注的回答'
                    : 'AI 将检索平台整理的法律法规条文，给出带来源标注的回答'}
                </div>
                <div className={styles.examples}>
                  {examples.map((q) => (
                    <button key={q} className={styles['example-btn']} onClick={() => query(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 消息 */}
        {messages.map((msg) => (
          <AiOrUserMsg
            key={msg.id}
            msg={msg}
            expandedSources={expandedSources}
            toggleSource={toggleSource}
          />
        ))}

        <div ref={bottomEl} />
      </div>

      {/* 输入框 */}
      <div className={styles['input-area']}>
        {(needSession || needUpload) && (
          <div className={styles['upload-hint']}>
            {needSession
              ? '💬 请先点击「＋ 新建会话」开始一轮隔离的问答；或切换到「⚖️ 平台法规库」直接提问。'
              : '⚠️ 当前会话还没有文档，请先在左侧上传；或切换到「⚖️ 平台法规库」提问。'}
          </div>
        )}
        <div className={`${styles['input-wrap']} ${focused ? styles.focused : ''}`}>
          <textarea
            ref={textareaEl}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value)
              autoResize()
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={handleKeydown}
            placeholder={
              needSession
                ? '请先新建会话后再提问...'
                : needUpload
                  ? '请先在当前会话上传文档后再提问...'
                  : isMine
                    ? '基于本会话文档提问... (Enter 发送，Shift+Enter 换行)'
                    : '咨询平台法规库... (Enter 发送，Shift+Enter 换行)'
            }
            disabled={querying || needUpload || needSession}
            rows={1}
            className={styles['qa-input']}
          />
          <button
            className={styles['btn-send']}
            onClick={send}
            disabled={!question.trim() || querying || needUpload || needSession}
          >
            {querying ? '...' : '提问'}
          </button>
        </div>
      </div>
    </div>
  )
}

// 单条消息（用户 / AI）
function AiOrUserMsg({ msg, expandedSources, toggleSource }) {
  const html = useMemo(() => renderMarkdown(msg.content), [msg.content])

  return (
    <div className={`${styles['message-wrap']} ${styles[msg.role] || ''}`}>
      {/* 用户问题 */}
      {msg.role === 'user' ? (
        <div className={styles['user-msg']}>
          <div className={`${styles.bubble} ${styles['user-bubble']}`}>{msg.content}</div>
        </div>
      ) : (
        /* AI 回答 */
        <div className={styles['ai-msg']}>
          {/* 检索状态提示 */}
          {msg.status && !msg.content && (
            <div className={styles['status-hint']}>
              <div className="spinner" />
              <span>{msg.status}</span>
            </div>
          )}

          {/* 来源文档（在回答之前展示） */}
          {msg.sources?.length > 0 && (
            <div className={styles['sources-panel']}>
              <div className={styles['sources-label']}>📎 参考文档（{msg.sources.length} 条）</div>
              <div className={styles['source-list']}>
                {msg.sources.map((src, i) => (
                  <div key={i} className={styles['source-item']} title={src.content}>
                    <span className={styles['source-num']}>[{i + 1}]</span>
                    <span className={styles['source-title']}>{src.title}</span>
                    <span className={styles['source-score']}>{(src.score * 100).toFixed(0)}%</span>
                    {/* 展开显示片段内容 */}
                    <button
                      className={styles['source-expand']}
                      onClick={() => toggleSource(msg.id, i)}
                    >
                      {expandedSources[`${msg.id}_${i}`] ? '▲' : '▼'}
                    </button>
                    {expandedSources[`${msg.id}_${i}`] && (
                      <div className={styles['source-content']}>{src.content}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 回答内容 */}
          {(msg.content || msg.streaming) && (
            <div
              className={`${styles.bubble} ${styles['ai-bubble']} markdown-body`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          {msg.streaming && msg.content && <span className="cursor-blink" />}
        </div>
      )}
    </div>
  )
}
