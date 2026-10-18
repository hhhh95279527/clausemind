// frontend/src/components/assistant/AssistantChatPanel.jsx
// 迷你聊天面板：左侧会话记录栏 + 右侧聊天区；标题栏可拖拽移动面板
// 直接复用 useAgentStore 的会话状态——与 /agent 页完全互通
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { renderMarkdown } from '@/utils/markdown.js'
import { useAgentStore } from '@/stores/agent.js'
import ToolCallCard from '@/components/agent/ToolCallCard.jsx'
import styles from './assistant.module.css'

export default function AssistantChatPanel({ onClose }) {
  const messages = useAgentStore((s) => s.messages)
  const running = useAgentStore((s) => s.running)
  const sessions = useAgentStore((s) => s.sessions)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const examples = useAgentStore((s) => s.examples)
  const newSession = useAgentStore((s) => s.newSession)
  const selectSession = useAgentStore((s) => s.selectSession)
  const runTask = useAgentStore((s) => s.runTask)
  const navigate = useNavigate()

  const [text, setText] = useState('')
  const [openExample, setOpenExample] = useState(null) // 展开的示例分类
  const bottomRef = useRef(null)

  // ── 标题栏拖拽移动面板 ─────────────────────────────
  const [drag, setDrag] = useState({ dx: 0, dy: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef(null)

  useEffect(() => {
    if (!dragging) return undefined
    const onMove = (e) => {
      const d = dragStart.current
      setDrag({ dx: d.bx + (e.clientX - d.sx), dy: d.by + (e.clientY - d.sy) })
    }
    const onUp = () => setDragging(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  const onHeaderDown = (e) => {
    if (e.button !== 0) return
    dragStart.current = { sx: e.clientX, sy: e.clientY, bx: drag.dx, by: drag.dy }
    setDragging(true)
  }

  const current = sessions.find((s) => s.id === currentSessionId)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = () => {
    const t = text.trim()
    if (!t || running) return
    setText('')
    runTask(t)
  }

  const handleKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const openExampleData = examples.find((e) => e.title === openExample)

  return (
    <div
      className={`${styles['panel']} ${dragging ? styles.dragging : ''}`}
      style={{ transform: `translate(${drag.dx}px, ${drag.dy}px)` }}
    >
      <div className={styles['panel-header']} onMouseDown={onHeaderDown}>
        <div className={styles['panel-title']}>
          <span className={styles['panel-avatar']}>🤖</span>
          <span className={styles['panel-name']}>小律</span>
          {current?.title && <span className={styles['panel-session']}>{current.title}</span>}
        </div>
        <div className={styles['panel-actions']} onMouseDown={(e) => e.stopPropagation()}>
          <button className={styles['panel-icon-btn']} title="打开完整任务 Agent" onClick={() => { navigate('/agent'); onClose() }}>↗</button>
          <button className={styles['panel-icon-btn']} title="收起" onClick={onClose}>✕</button>
        </div>
      </div>

      <div className={styles['panel-body']}>
        {/* 左侧会话记录栏 */}
        <div className={styles['panel-rail']}>
          <button className={styles['rail-new']} disabled={running} onClick={() => newSession()}>＋ 新会话</button>
          <div className={styles['rail-list']}>
            {sessions.length === 0 && <div className={styles['rail-empty']}>暂无会话记录</div>}
            {sessions.map((s) => (
              <button
                key={s.id}
                className={`${styles['rail-item']} ${s.id === currentSessionId ? styles['rail-item-active'] : ''}`}
                title={s.title}
                disabled={running}
                onClick={() => selectSession(s.id)}
              >
                {s.title}
              </button>
            ))}
          </div>
        </div>

        {/* 右侧聊天区 */}
        <div className={styles['panel-chat']}>
          <div className={styles['panel-messages']}>
            {!messages.length ? (
              <div className={styles['panel-empty']}>
                <div className={styles['panel-hello']}>Hi，我是小律 🤖</div>
                <div className={styles['panel-sub']}>合同查询、法规核查、台账预警、金额计算都可以问我</div>
                <div className={styles['panel-quick']}>
                  {examples.slice(0, 5).map((ex) => (
                    <button
                      key={ex.title}
                      className={openExample === ex.title ? styles['chip-active'] : ''}
                      disabled={running}
                      onClick={() => setOpenExample(openExample === ex.title ? null : ex.title)}
                    >
                      {ex.title}
                    </button>
                  ))}
                </div>
                {/* 展开所选分类的 3 条示例问题 */}
                {openExampleData && (
                  <div className={styles['panel-prompts']}>
                    {openExampleData.prompts.map((p, i) => (
                      <button key={i} className={styles['prompt-item']} disabled={running} onClick={() => runTask(p)}>
                        <span className={styles['prompt-idx']}>{i + 1}</span>
                        <span>{p}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className={styles['pmsg-user']}>{m.content}</div>
                ) : (
                  <div key={m.id} className={styles['pmsg-ai']}>
                    {m.steps?.length > 0 && (
                      <div className={styles['pmsg-steps']}>
                        {m.steps.map((step) => <ToolCallCard key={step.id} step={step} />)}
                      </div>
                    )}
                    {m.streaming && !m.steps?.length && (
                      <div className={styles['pmsg-thinking']}><span className="spinner" />正在思考...</div>
                    )}
                    {m.content && (
                      <div
                        className={`${styles['pmsg-content']} markdown-body`}
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }}
                      />
                    )}
                  </div>
                )
              )
            )}
            <div ref={bottomRef} />
          </div>

          <div className={styles['panel-input']}>
            <textarea
              rows={1}
              value={text}
              placeholder={running ? '小律正在执行...' : '问点什么…（Enter 发送）'}
              disabled={running}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeydown}
            />
            <button className="btn btn-primary" onClick={send} disabled={!text.trim() || running}>
              {running ? '…' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
