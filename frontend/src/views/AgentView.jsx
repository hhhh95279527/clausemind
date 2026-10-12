// frontend/src/views/AgentView.jsx
// Agent 页面：左侧任务输入 + 示例/工具，右侧执行记录
import { useState, useEffect, useMemo } from 'react'
import { renderMarkdown } from '@/utils/markdown.js'
import { useAgentStore } from '@/stores/agent.js'
import { useAppStore } from '@/stores/app.js'
import ToolCallCard from '@/components/agent/ToolCallCard.jsx'
import styles from './AgentView.module.css'

function formatTime(iso) {
  return iso
    ? new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : ''
}

export default function AgentView() {
  const tasks = useAgentStore((s) => s.tasks)
  const running = useAgentStore((s) => s.running)
  const examples = useAgentStore((s) => s.examples)
  const toolList = useAgentStore((s) => s.toolList)
  const clearTasks = useAgentStore((s) => s.clearTasks)
  const runTask = useAgentStore((s) => s.runTask)

  const [taskText, setTaskText] = useState('')

  useEffect(() => {
    useAgentStore.getState().loadMeta()
  }, [])

  async function handleRun() {
    if (!taskText.trim() || running) return
    const t = taskText.trim()
    setTaskText('')
    await runTask(t)
  }

  function useExample(task) {
    if (!running) setTaskText(task)
  }

  async function copyAnswer(text) {
    await navigator.clipboard.writeText(text)
    useAppStore.getState().toast.success('已复制')
  }

  return (
    <div className={styles['agent-view']}>
      <aside className={styles['task-panel']}>
        <div className={styles['panel-header']}>
          <span className={styles['panel-title']}>任务 Agent</span>
          {tasks.length > 0 && (
            <button className={styles['btn-text-sm']} onClick={clearTasks}>清空</button>
          )}
        </div>

        <div className={styles['task-input-area']}>
          <textarea
            className={styles['task-textarea']}
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                e.preventDefault()
                handleRun()
              }
            }}
            placeholder="描述你的任务，Agent 会自动拆解步骤..."
            disabled={running}
            rows={4}
          />
          <div className={styles['input-actions']}>
            <span className={styles.hint}>Ctrl+Enter 执行</span>
            <button
              className="btn btn-primary"
              onClick={handleRun}
              disabled={!taskText.trim() || running}
            >
              {running ? '执行中...' : '执行任务'}
            </button>
          </div>
        </div>

        <div className={styles['examples-section']}>
          <div className={styles['section-label']}>示例任务</div>
          {examples.map((ex) => (
            <div
              key={ex.title}
              className={`${styles['example-item']} ${running ? styles.disabled : ''}`}
              onClick={() => useExample(ex.task)}
            >
              <div className={styles['ex-content']}>
                <div className={styles['ex-title']}>{ex.title}</div>
                <div className={styles['ex-desc']}>{ex.task.slice(0, 40)}...</div>
              </div>
            </div>
          ))}
        </div>

        <div className={styles['tools-section']}>
          <div className={styles['section-label']}>可用工具（{toolList.length}）</div>
          <div className={styles['tool-chips']}>
            {toolList.map((t) => (
              <div key={t.name} className={styles['tool-chip']} title={t.description}>
                {t.label}
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className={styles['execution-panel']}>
        {!tasks.length ? (
          <div className={styles['empty-state']}>
            <div className={styles['empty-title']}>合同管理任务 Agent</div>
            <div className={styles['empty-desc']}>
              在左侧输入任务，Agent 会自动查询本企业合同数据、检索法规与规则，规划步骤完成
            </div>
            <div className={styles['feature-tags']}>
              <span className="tag tag-blue">合同与台账查询</span>
              <span className="tag tag-red">风险统计复盘</span>
              <span className="tag tag-purple">法规条文检索</span>
              <span className="tag tag-amber">到期预警与计算</span>
            </div>
          </div>
        ) : (
          <div className={styles['task-list']}>
            {tasks.map((task) => (
              <TaskBlock key={task.id} task={task} onCopy={copyAnswer} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}

// 单个任务卡片
function TaskBlock({ task, onCopy }) {
  const answerHtml = useMemo(() => renderMarkdown(task.answer), [task.answer])

  return (
    <div className={styles['task-block']}>
      <div className={styles['task-header']}>
        <div className={styles['task-meta']}>
          <span className={`task-status-dot dot-${task.status}`} style={{ width: 7, height: 7, borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
          <span className={styles['task-index']}>任务 #{task.id}</span>
          <span className={styles['task-time']}>{formatTime(task.startTime)}</span>
          {task.duration > 0 && (
            <span className={styles['task-duration']}>{(task.duration / 1000).toFixed(1)}s</span>
          )}
        </div>
        <div className={styles['task-desc']}>{task.task}</div>
      </div>

      {task.steps.length > 0 && (
        <div className={styles['steps-list']}>
          {task.steps.map((step) => (
            <ToolCallCard key={step.id} step={step} />
          ))}
        </div>
      )}

      {task.status === 'running' && !task.steps.length && (
        <div className={styles['thinking-hint']}>
          <div className="spinner" />
          <span>Agent 正在思考...</span>
        </div>
      )}

      {task.answer && (
        <div className={styles['final-answer']}>
          <div className={styles['answer-header']}>
            <span>最终回答</span>
            <button className={styles['btn-copy']} onClick={() => onCopy(task.answer)}>
              复制
            </button>
          </div>
          <div
            className={`${styles['answer-content']} markdown-body`}
            dangerouslySetInnerHTML={{ __html: answerHtml }}
          />
          {task.status === 'running' && <span className="cursor-blink" />}
        </div>
      )}

      {task.status === 'error' && (
        <div className={styles['error-hint']}>
          {task.answer || '任务执行失败，请重试'}
        </div>
      )}
    </div>
  )
}
