// frontend/src/components/billing/Paywall.jsx
// 统一付费墙：深度券 / 月付 / 年付三入口。文案与 new-review/review/draft 原型一致。
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Button } from 'antd'
import { LockOutlined, CheckOutlined } from '@ant-design/icons'
import { PRICES } from '@/config/plans.js'

const FEATS = [
  'AI 语义审查 + 法条依据，置信度透明',
  '逐条修改建议与可直接替换的措辞',
  '合同助手多轮追问与 AI 改稿',
  'Word 红划线导出与永久存档',
]

export default function Paywall({
  open,
  onClose,
  couponBalance = 0,
  onUseCoupon,
  description = '免费版已给出风险点、摘要与评分；深度内容让你知道依据是什么、具体怎么改。',
  cancelText = '暂不解锁，继续看免费结果',
}) {
  const navigate = useNavigate()
  const [using, setUsing] = useState(false)

  const useCoupon = async () => {
    if (!couponBalance || couponBalance <= 0) {
      // 无券：第一入口转为购券（FR-12 统一付费墙三入口：券 / 月付 / 年付）
      navigate('/checkout?item=COUPON_PACK')
      return
    }
    setUsing(true)
    try {
      await onUseCoupon?.()
      onClose?.()
    } finally {
      setUsing(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={440}
      centered
      closable
      // 禁用缩放退出动画：部分内嵌浏览器不触发 animationend 会导致弹窗关不掉
      transitionName=""
      maskTransitionName=""
    >
      <div style={{ textAlign: 'center', padding: '8px 4px 4px' }}>
        <div style={{
          width: 56, height: 56, borderRadius: '50%', background: 'var(--color-primary-bg)',
          color: 'var(--color-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          margin: '0 auto 14px',
        }}>
          <LockOutlined style={{ fontSize: 26 }} />
        </div>
        <h3 style={{ fontSize: 18, marginBottom: 8 }}>解锁完整深度审查</h3>
        <p style={{ color: 'var(--color-text-sub)', fontSize: 13, marginBottom: 16, lineHeight: 1.8 }}>
          {description}
        </p>
        <ul style={{ listStyle: 'none', textAlign: 'left', marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 9 }}>
          {FEATS.map((f) => (
            <li key={f} style={{ display: 'flex', gap: 9, fontSize: 13.5, alignItems: 'flex-start' }}>
              <span style={{
                color: 'var(--color-success)', flex: 'none', width: 18, height: 18,
                borderRadius: '50%', background: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
              }}>
                <CheckOutlined />
              </span>
              {f}
            </li>
          ))}
        </ul>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Button type="primary" size="large" block loading={using} onClick={useCoupon}>
            {couponBalance > 0
              ? `使用 1 张深度券（余额 ${couponBalance} 张）`
              : `购买深度券 ¥${PRICES.COUPON_UNIT}/份（余额 0 张）`}
          </Button>
          <Button size="large" block onClick={() => navigate('/checkout?plan=PERSONAL&period=monthly')}>
            开通个人版 ¥{PRICES.PERSONAL_MONTHLY}/月
          </Button>
          <Button type="link" block onClick={() => navigate('/checkout?plan=PERSONAL&period=yearly')}>
            年付 ¥{PRICES.PERSONAL_YEARLY}，省 48% →
          </Button>
        </div>
        <div style={{ marginTop: 12 }}>
          <a onClick={onClose} style={{ fontSize: 12.5, color: 'var(--color-text-muted)' }}>{cancelText}</a>
        </div>
      </div>
    </Modal>
  )
}
