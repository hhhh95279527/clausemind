// frontend/src/components/common/PagePlaceholder.jsx
// 通用页面占位组件：Phase 0.3 路由骨架期避免新路由 404；后续 Phase 实现具体页面后逐个替换
import { FileTextOutlined } from '@ant-design/icons'

/**
 * 占位组件
 * @param {object} props
 * @param {string} props.title    页面标题
 * @param {string} props.phase    实施阶段标识（如 'Phase 4'）
 * @param {string} props.desc     简短描述
 */
export default function PagePlaceholder({ title, phase, desc }) {
  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
      padding: 48,
      color: 'var(--color-text-sub)',
    }}>
      <FileTextOutlined style={{ fontSize: 48, color: 'var(--color-text-muted)' }} />
      <h2 style={{ margin: 0, color: 'var(--color-text)', fontSize: 20, fontWeight: 600 }}>
        {title}
      </h2>
      {desc && <p style={{ margin: 0, maxWidth: 480, textAlign: 'center' }}>{desc}</p>}
      <span style={{
        padding: '2px 10px',
        background: 'var(--color-primary-bg)',
        color: 'var(--color-primary)',
        borderRadius: 9999,
        fontSize: 12,
      }}>
        待实施 · {phase}
      </span>
    </div>
  )
}
