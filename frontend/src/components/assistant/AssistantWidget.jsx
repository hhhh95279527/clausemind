// frontend/src/components/assistant/AssistantWidget.jsx
// 全局 3D 助手浮窗：右下角悬浮机器人（R3F），点击展开迷你聊天面板
// 复用 useAgentStore —— 浮窗会话与 /agent 页互通；/agent 页面自身隐藏
import { useEffect, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { useLocation } from 'react-router-dom'
import { useAgentStore } from '@/stores/agent.js'
import RobotModel from './RobotModel.jsx'
import AssistantChatPanel from './AssistantChatPanel.jsx'
import styles from './assistant.module.css'

const HINT_KEY = 'workmind_assistant_hint_seen'

// ── 小律主动说话的话术库 ─────────────────────────────
// 通用池：任何页面都可能说
const GENERIC_LINES = [
  '有问题随时点我，合同的事我都懂一点 🤖',
  '试试问我：「我的套餐有什么功能」',
  '我能查合同、查法条、算违约金、排到期',
  '不想打字？面板里有示例任务，点一下就能跑',
  '拿不准某个功能在哪？直接问我',
  '条款想改又不知道怎么措辞？让我帮你改写',
]
// 场景池：按路由匹配，进到对应页面时优先说这些（平台功能导览）
const ROUTE_LINES = [
  [/^\/contracts/, ['支持 Word/PDF 上传，Word 的审查效果最好', '档案里的合同可以按状态和风险数筛选，试试？']],
  [/^\/review/, ['高风险项建议优先处理，需要我解读哪一条吗？', '审查报告可以导出 Word/PDF，右上角找导出入口']],
  [/^\/ledger/, ['问我「列出 30 天内到期的合同」，续签节奏一手掌握', '台账里 30 天内到期的会标红，记得及时续签']],
  [/^\/billing/, ['想了解各套餐区别？问我一句就清楚', '深度券可以按次体验 AI 改写，不用先订阅']],
  [/^\/rag/, ['法条问题尽管问，我会附上条文原文出处']],
  [/^\/agent/, ['这里是我的完整工作台，尽管派活', '左侧是历史会话，随时可以接着上次聊']],
]

export default function AssistantWidget() {
  const [open, setOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const location = useLocation()
  const running = useAgentStore((s) => s.running)
  // 全局鼠标视线（ref 直读，不触发重渲染）：相对屏幕中心归一化，右上 = x>0,y<0
  const gazeRef = useRef({ x: 0, y: 0 })
  // 挥手信号（递增 tick，DOM 点击/主动说话触发，绕开 Three.js 射线拾取的不稳定）
  const waveRef = useRef(0)
  // 主动说话的气泡文案（null=不显示）
  const [chatter, setChatter] = useState(null)
  // 供定时器读取最新状态，避免闭包过期
  const stRef = useRef({ open, hint, running, pathname: location.pathname, agentTip: false, chatter: null })
  stRef.current.open = open
  stRef.current.hint = hint
  stRef.current.running = running
  stRef.current.pathname = location.pathname
  stRef.current.chatter = chatter
  const lastLineIdx = useRef(-1)
  const chatterTimer = useRef(null)

  // 说一句话：挥手 + 气泡 5 秒；点击气泡可直接打开面板
  const say = (line) => {
    waveRef.current += 1
    setChatter(line)
    clearTimeout(chatterTimer.current)
    chatterTimer.current = setTimeout(() => setChatter(null), 5000)
  }

  const pickLine = () => {
    const routePool = (ROUTE_LINES.find(([re]) => re.test(stRef.current.pathname)) || [])[1] || []
    const pool = [...routePool, ...GENERIC_LINES]
    let i = Math.floor(Math.random() * pool.length)
    if (pool.length > 1 && i === lastLineIdx.current) i = (i + 1) % pool.length
    lastLineIdx.current = i
    return pool[i]
  }

  // 空闲时主动搭话：每 40~80s 随机一次；面板打开/任务执行中/标签页不可见/其他气泡在显示时跳过
  useEffect(() => {
    let stopped = false
    let timer = null
    const schedule = (delay) => {
      timer = setTimeout(() => {
        if (stopped) return
        const s = stRef.current
        if (document.visibilityState !== 'visible' || s.open || s.hint || s.agentTip || s.running) {
          schedule(30_000)
          return
        }
        say(pickLine())
        schedule(40_000 + Math.random() * 40_000)
      }, delay)
    }
    schedule(20_000) // 首次 20s 后开口，不与首访气泡撞车
    return () => { stopped = true; clearTimeout(timer); clearTimeout(chatterTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切换页面 6s 后给一句该场景的功能提示（面板关着且没在说话时）
  useEffect(() => {
    const t = setTimeout(() => {
      const s = stRef.current
      if (!s.open && !s.hint && !s.agentTip && !s.chatter && document.visibilityState === 'visible') {
        say(pickLine())
      }
    }, 6000)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  // 任务执行完成（running true→false）且面板关着时报喜
  const prevRunning = useRef(running)
  useEffect(() => {
    const was = prevRunning.current
    prevRunning.current = running
    if (was && !running && !stRef.current.open) {
      say('任务完成啦，点开看看结果？')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  // 眼睛/头部跟随整个页面的鼠标
  useEffect(() => {
    const onMove = (e) => {
      gazeRef.current.x = Math.max(-1, Math.min(1, (e.clientX - window.innerWidth / 2) / (window.innerWidth / 2)))
      gazeRef.current.y = Math.max(-1, Math.min(1, (e.clientY - window.innerHeight / 2) / (window.innerHeight / 2)))
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [])

  // 首次访问一次性气泡提示
  useEffect(() => {
    if (!localStorage.getItem(HINT_KEY)) {
      setHint(true)
      const timer = setTimeout(() => setHint(false), 8000)
      return () => clearTimeout(timer)
    }
  }, [])

  // ── 机器人拖拽移动（拖动超过 4px 视为拖拽，松手不触发点击）────────
  const [pos, setPos] = useState({ dx: 0, dy: 0 })
  const [draggingBall, setDraggingBall] = useState(false)
  const ballDrag = useRef(null)

  useEffect(() => {
    if (!draggingBall) return undefined
    const onMove = (e) => {
      const d = ballDrag.current
      if (Math.abs(e.clientX - d.sx) > 4 || Math.abs(e.clientY - d.sy) > 4) d.moved = true
      // 钳制在屏幕范围内（默认锚点右下角：向左/向上为负）
      setPos({
        dx: Math.max(-(window.innerWidth - 150), Math.min(0, d.bx + (e.clientX - d.sx))),
        dy: Math.max(-(window.innerHeight - 170), Math.min(0, d.by + (e.clientY - d.sy))),
      })
    }
    const onUp = () => setDraggingBall(false)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingBall])

  const onBallDown = (e) => {
    if (e.button !== 0) return
    ballDrag.current = { sx: e.clientX, sy: e.clientY, bx: pos.dx, by: pos.dy, moved: false }
    setDraggingBall(true)
  }

  // 任务 Agent 页已有完整聊天工作台：机器人仍然在场（陪伴 + 挥手），但不弹迷你面板避免重复
  const onAgentPage = location.pathname.startsWith('/agent')

  // 进入 /agent 页时短暂提示（4s，不写 localStorage）
  const [agentTip, setAgentTip] = useState(false)
  stRef.current.agentTip = agentTip
  useEffect(() => {
    if (!onAgentPage) {
      setAgentTip(false)
      return undefined
    }
    setAgentTip(true)
    const timer = setTimeout(() => setAgentTip(false), 4000)
    return () => clearTimeout(timer)
  }, [onAgentPage])

  const activate = () => {
    if (onAgentPage) return
    setOpen((o) => {
      if (!o) {
        localStorage.setItem(HINT_KEY, '1')
        setHint(false)
      }
      return !o
    })
  }

  // DOM 点击（稳定）：真实拖拽后松手不触发；每次点击都挥手
  const handleBallClick = () => {
    if (ballDrag.current?.moved) {
      ballDrag.current.moved = false
      return
    }
    waveRef.current += 1
    activate()
  }

  return (
    <div
      className={styles['assistant-root']}
      style={{ transform: `translate(${pos.dx}px, ${pos.dy}px)` }}
    >
      {open && !onAgentPage && <AssistantChatPanel onClose={() => setOpen(false)} />}
      {hint && !open && !onAgentPage && <div className={styles['assistant-hint']}>点我，问任何合同问题 👋</div>}
      {agentTip && <div className={styles['assistant-hint']}>我就是小律，这里是我的完整工作台 👋</div>}
      {chatter && !open && !hint && !agentTip && (
        <button
          className={`${styles['assistant-hint']} ${styles['hint-clickable']}`}
          onClick={() => { setChatter(null); clearTimeout(chatterTimer.current); activate() }}
        >
          {chatter}
        </button>
      )}
      <button
        className={`${styles['assistant-ball']} ${open ? styles['ball-open'] : ''} ${draggingBall ? styles['ball-dragging'] : ''}`}
        title="智能助手 小律（可拖动）"
        onMouseDown={onBallDown}
        onClick={handleBallClick}
      >
        <Canvas
          camera={{ position: [0, 0.15, 3.4], fov: 38 }}
          dpr={[1, 2]}
          gl={{ alpha: true, antialias: true }}
        >
          <ambientLight intensity={0.85} />
          <directionalLight position={[2, 3, 4]} intensity={1.25} />
          <directionalLight position={[-3, -1, 2]} intensity={0.4} color="#8fb0ff" />
          <RobotModel running={running} gazeRef={gazeRef} waveRef={waveRef} />
        </Canvas>
        {running && <span className={styles['assistant-running-dot']} />}
      </button>
    </div>
  )
}
