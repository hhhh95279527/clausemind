// frontend/src/components/layout/ScrollArrows.jsx
// 桌面端右侧悬浮上下箭头：点击平滑滚动页面内容（滚动目标为 .page-content 滚动容器）。
// 到顶隐藏上箭头、到底隐藏下箭头；内容不超长时整体隐藏。
// ≤768 触屏端由 global.css 隐藏（手指直接滑动）。
import { useCallback, useEffect, useState } from 'react'
import { UpOutlined, DownOutlined } from '@ant-design/icons'

export default function ScrollArrows() {
  const [canUp, setCanUp] = useState(false)
  const [canDown, setCanDown] = useState(false)

  const getContainer = useCallback(
    () => document.querySelector('.page-content') || null,
    [],
  )

  const refresh = useCallback(() => {
    const el = getContainer()
    if (!el) {
      setCanUp(false)
      setCanDown(false)
      return
    }
    const { scrollTop, scrollHeight, clientHeight } = el
    // 2px 容差，避免亚像素导致边界状态抖动
    setCanUp(scrollTop > 2)
    setCanDown(scrollTop + clientHeight < scrollHeight - 2)
  }, [getContainer])

  useEffect(() => {
    const el = getContainer()
    if (!el) return

    refresh()
    el.addEventListener('scroll', refresh, { passive: true })
    window.addEventListener('resize', refresh)

    // 异步内容（审查结果/列表）加载后高度会变：观察内容子树尺寸变化重算
    const observer = new ResizeObserver(refresh)
    observer.observe(el)
    Array.from(el.children).forEach((child) => observer.observe(child))

    return () => {
      el.removeEventListener('scroll', refresh)
      window.removeEventListener('resize', refresh)
      observer.disconnect()
    }
  }, [getContainer, refresh])

  const scrollBy = (dir) => {
    const el = getContainer()
    if (!el) return
    // 每次移动视口高度的 75%，保留上下文
    const step = Math.round(el.clientHeight * 0.75) * dir
    el.scrollBy({ top: step, behavior: 'smooth' })
  }

  if (!canUp && !canDown) return null

  const btnBase = {
    width: 38,
    height: 38,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--color-surface)',
    color: 'var(--color-primary)',
    boxShadow: 'var(--shadow-md)',
    border: '1px solid var(--color-border)',
    transition: 'opacity .2s, background .2s',
  }

  return (
    <div
      className="scroll-arrows"
      style={{
        position: 'fixed',
        right: 16,
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 80,
      }}
    >
      {canUp && (
        <button
          aria-label="向上滚动"
          title="向上"
          style={btnBase}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-primary-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--color-surface)')}
          onClick={() => scrollBy(-1)}
        >
          <UpOutlined />
        </button>
      )}
      {canDown && (
        <button
          aria-label="向下滚动"
          title="向下"
          style={btnBase}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-primary-bg)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--color-surface)')}
          onClick={() => scrollBy(1)}
        >
          <DownOutlined />
        </button>
      )}
    </div>
  )
}
