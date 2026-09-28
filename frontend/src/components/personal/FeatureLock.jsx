// frontend/src/components/personal/FeatureLock.jsx
// 风险卡深度三行（法条依据/修改建议/替代措辞）：未解锁时毛玻璃遮罩 + 付费墙入口
import { LockOutlined } from '@ant-design/icons'
import { PRICES } from '@/config/plans.js'
import styles from '@/views/personal/personal.module.css'

export default function FeatureLock({ locked, legalBasis, suggestion, rewritten, onUpgrade, onCoupon }) {
  const rows = [
    { label: '法条依据', text: legalBasis },
    { label: '修改建议', text: suggestion },
    { label: '替代措辞', text: rewritten },
  ]
  return (
    <div className={styles.lock}>
      <div className={styles.lockRows}>
        {rows.map((r) => (
          <div key={r.label}>
            <span className={`${styles.tag} ${styles.tagGray} ${styles.lockTag}`}>{r.label}</span>
            {r.text || '深度审查完成后展示。'}
          </div>
        ))}
      </div>
      {locked && (
        <div className={styles.lockOver}>
          <span className={styles.lockIc}><LockOutlined /></span>
          <div className={styles.lockTxt}>开通个人版查看：法条依据 · 修改建议 · 替代措辞</div>
          <button className="btn btn-primary btn-sm" onClick={onUpgrade}>开通个人版</button>
          <a className={styles.small} onClick={onCoupon}>或用 1 张深度券解锁（¥{PRICES.COUPON_UNIT}）</a>
        </div>
      )}
    </div>
  )
}
