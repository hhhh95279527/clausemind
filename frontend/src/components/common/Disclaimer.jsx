// frontend/src/components/common/Disclaimer.jsx
// AI 免责声明条：审查结果页 / 导出件统一展示（FR-5、FR-8）
import { InfoCircleOutlined } from '@ant-design/icons'

/**
 * @param {object} props
 * @param {'bar'|'text'|'watermark'} props.variant
 *   bar=结果页黄色提示条；text=文末小号说明；watermark=免费导出 PDF 水印文案
 * @param {boolean} props.free 是否免费版（额外提示记录保留 7 天）
 */
export default function Disclaimer({ variant = 'bar', free = false }) {
  if (variant === 'watermark') {
    return 'WorkMind 免费版 · 仅供风险提示，不构成法律意见'
  }

  const text = 'AI 风险提示仅供参考，不构成法律意见，重大合同建议咨询执业律师。'

  if (variant === 'text') {
    return (
      <p style={{
        margin: '12px 0 0',
        fontSize: 12,
        color: 'var(--color-text-muted)',
        lineHeight: 1.7,
      }}>
        {text}
        {free ? '免费版审查记录自完成起保留 7 天，到期自动删除，请及时保存。' : ''}
      </p>
    )
  }

  // bar：结果页/导出前统一黄条
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8px,
      padding: '10px 14px',
      background: '#fffbeb',
      border: '1px solid #fde68a',
      borderRadius: 8,
      fontSize: 12.5,
      color: '#92400e',
      lineHeight: 1.7,
    }}>
      <InfoCircleOutlined style={{ marginTop: 3, flex: 'none' }} />
      <span>
        {text}
        {free && ' 当前为免费版，审查记录保留 7 天。'}
      </span>
    </div>
  )
}
