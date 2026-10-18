// frontend/src/views/AgentView.jsx
// Agent 页面：左 会话列表（多轮持久化）｜右 聊天区（工具步骤 + Markdown 回答 + 底部输入）
import { useState, useEffect, useRef, useMemo } from 'react'
import { renderMarkdown } from '@/utils/markdown.js'
import { useAgentStore } from '@/stores/agent.js'
import { useAppStore } from '@/stores/app.js'
import { useMeStore } from '@/stores/me.js'
import SessionSidebar from '@/components/rag/SessionSidebar.jsx'
import ToolCallCard from '@/components/agent/ToolCallCard.jsx'
import styles from './AgentView.module.css'

export default function AgentView() {
  const messages = useAgentStore((s) => s.messages)
  const running = useAgentStore((s) => s.running)
  const examples = useAgentStore((s) => s.examples)
  const toolList = useAgentStore((s) => s.toolList)
  const sessions = useAgentStore((s) => s.sessions)
  const currentSessionId = useAgentStore((s) => s.currentSessionId)
  const newSession = useAgentStore((s) => s.newSession)
  const selectSession = useAgentStore((s) => s.selectSession)
  const removeSession = useAgentStore((s) => s.removeSession)
  const runTask = useAgentStore((s) => s.runTask)

  const [taskText, setTaskText] = useState('')
  const [openExample, setOpenExample] = useState(null) // 当前展开的分类示例
  const textareaEl = useRef(null)
  const bottomEl = useRef(null)

  // 到期预警示例依赖团队台账（个人空间已下线该模块），仅团队空间展示
  const isTeamSpace = useMeStore((s) => s.entitlement?.workspaceType) === 'TEAM'
  const visibleExamples = examples.filter((ex) => !ex.teamOnly || isTeamSpace)

  useEffect(() => {
    const agent = useAgentStore.getState()
    agent.loadMeta()
    agent.loadSessions()
  }, [])

  // 新消息/流式输出自动滚底
  useEffect(() => {
    bottomEl.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = taskText.trim()
    if (!text || running) return
    setTaskText('')
    resetHeight()
    await runTask(text)
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      send()
    }
  }

  function autoResize() {
    const el = textareaEl.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  function resetHeight() {
    if (textareaEl.current) textareaEl.current.style.height = 'auto'
  }

  return (
    <div className={styles['agent-view']}>
      <SessionSidebar
        sessions={sessions}
        currentSessionId={currentSessionId}
        busy={running}
        onNew={newSession}
        onSelect={selectSession}
        onDelete={removeSession}
        icon="🛠"
        newHint="开始一个全新的任务会话"
        emptyHint="暂无任务会话"
        emptySub="在右侧描述任务，执行历史自动保存"
        deleteConfirm={{
          title: '删除会话',
          content: '确定删除会话「{title}」？该会话的全部任务记录将一并删除且无法恢复。',
        }}
      />

      <main className={styles['chat-panel']}>
        <div className={styles['chat-header']}>
          <div>
            <div className={styles['chat-title']}>任务 Agent</div>
            <div className={styles['chat-sub']}>自动规划步骤、调用业务工具完成合同管理任务，支持多轮追问</div>
          </div>
          <div className={styles['tool-chips']}>
            {toolList.map((t) => (
              <div key={t.name} className={styles['tool-chip']} title={t.description}>
                {t.label}
              </div>
            ))}
          </div>
        </div>

        <div className={styles['chat-messages']}>
          {!messages.length ? (
            <div className={styles['empty-state']}>
              <div className={styles['empty-title']}>合同管理任务 Agent</div>
              <div className={styles['empty-desc']}>
                描述你的任务，Agent 会自动查询本企业合同数据、检索法规与规则，规划步骤完成；
                执行后可继续追问，会话历史自动保存
              </div>
              <div className={styles['feature-tags']}>
                <span className="tag tag-blue">合同与台账查询</span>
                <span className="tag tag-red">风险统计复盘</span>
                <span className="tag tag-purple">法规条文检索</span>
                <span className="tag tag-amber">到期预警与计算</span>
              </div>
              <div className={styles['example-chips']}>
                {visibleExamples.map((ex) => (
                  <button
                    key={ex.title}
                    className={`${styles['example-chip']} ${openExample === ex.title ? styles.active : ''}`}
                    disabled={running}
                    onClick={() => setOpenExample(openExample === ex.title ? null : ex.title)}
                  >
                    {ex.title}
                  </button>
                ))}
              </div>

              {/* 展开所选分类的高频问题，点击直接执行 */}
              {openExample && visibleExamples.find((e) => e.title === openExample) && (
                <div className={styles['example-prompts']}>
                  {visibleExamples.find((e) => e.title === openExample).prompts.map((p, i) => (
                    <button
                      key={i}
                      className={styles['example-prompt-item']}
                      disabled={running}
                      onClick={() => runTask(p)}
                    >
                      <span className={styles['prompt-idx']}>{i + 1}</span>
                      <span>{p}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((msg) => <MessageBlock key={msg.id} msg={msg} />)
          )}
          <div ref={bottomEl} />
        </div>

        <div className={styles['chat-input']}>
          <textarea
            ref={textareaEl}
            className={styles['task-textarea']}
            value={taskText}
            onChange={(e) => { setTaskText(e.target.value); autoResize() }}
            onKeyDown={handleKeydown}
            placeholder="描述你的任务，支持多轮追问；Agent 会自动拆解步骤..."
            disabled={running}
            rows={2}
          />
          <div className={styles['input-actions']}>
            <span className={styles.hint}>Ctrl+Enter 执行</span>
            <button className="btn btn-primary" onClick={send} disabled={!taskText.trim() || running}>
              {running ? '执行中...' : '执行任务'}
            </button>
          </div>
        </div>
      </main>
    </div>
  )
}

// 单条消息：user 右侧气泡；assistant 左侧卡片（工具步骤 + Markdown 回答）
function MessageBlock({ msg }) {
  const answerHtml = useMemo(() => renderMarkdown(msg.content), [msg.content])

  if (msg.role === 'user') {
    return <div className={styles['msg-user']}>{msg.content}</div>
  }

  const copyAnswer = async () => {
    await navigator.clipboard.writeText(msg.content)
    useAppStore.getState().toast.success('已复制')
  }

  return (
    <div className={styles['msg-assistant']}>
      {msg.steps.length > 0 && (
        <div className={styles['steps-list']}>
          {msg.steps.map((step) => (
            <ToolCallCard key={step.id} step={step} />
          ))}
        </div>
      )}

      {msg.streaming && !msg.steps.length && (
        <div className={styles['thinking-hint']}>
          <div className="spinner" />
          <span>Agent 正在思考...</span>
        </div>
      )}

      {msg.content && (
        <div className={styles['answer-wrap']}>
          <div
            className={`${styles['answer-content']} markdown-body`}
            dangerouslySetInnerHTML={{ __html: answerHtml }}
          />
          <div className={styles['answer-footer']}>
            {msg.streaming && <span className="cursor-blink" />}
            {!msg.streaming && (
              <button className={styles['btn-copy']} onClick={copyAnswer}>复制</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
