// frontend/src/views/personal/DraftView.jsx
// AI 改稿台：逐条接受/拒绝/重新生成/模拟反驳/全部接受/对比原版/导出 Word 红划线
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import {
  LockOutlined, EditOutlined, SwapOutlined, CheckOutlined, FileWordOutlined,
  InfoCircleOutlined, ArrowLeftOutlined,
} from '@ant-design/icons'
import { Modal, Spin } from 'antd'
import { useRevisionStore } from '@/stores/revision.js'
import { useContractStore } from '@/stores/contract.js'
import { useMeStore } from '@/stores/me.js'
import { useAppStore } from '@/stores/app.js'
import Paywall from '@/components/billing/Paywall.jsx'
import styles from './personal.module.css'

const SEV = {
  HIGH: { tag: styles.tagRed, text: '高风险' },
  MED: { tag: styles.tagOrange, text: '中风险' },
  LOW: { tag: styles.tagBlue, text: '低风险' },
}
const STATUS_TAG = {
  PENDING: { cls: styles.tagOrange, text: '待确认' },
  ACCEPTED: { cls: styles.tagGreen, text: '已接受' },
  REJECTED: { cls: styles.tagGray, text: '已拒绝' },
}

export default function DraftView() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)
  const { data, loading, load, generate, setStatus, acceptAll, regenerate, rebuttal, downloadDocx, acting } = useRevisionStore()
  const { startReview } = useContractStore()
  const { entitlement, loadEntitlement } = useMeStore()

  const [paywall, setPaywall] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [rebuts, setRebutals] = useState({})

  const refresh = useCallback(() => load(id), [id, load])
  useEffect(() => {
    loadEntitlement()
    refresh()
  }, [refresh, loadEntitlement])

  const deep = !!data?.deep
  const revisions = data?.revisions || []
  const generated = data?.generated
  const accepted = data?.acceptedCount || 0
  const total = revisions.length
  const couponBalance = entitlement?.couponBalance ?? 0

  const unlockWithCoupon = async () => {
    // 券通道：对本份合同重跑一次深度审查（原子扣 1 券），再重载改稿数据
    const { blocked } = await startReview(id, { payWithCoupon: true })
    await loadEntitlement()
    await refresh()
    if (blocked) {
      setPaywall(true)
      throw new Error('blocked')
    }
  }

  const doGenerate = async () => {
    try {
      await generate(id, false)
      toast.success('修订建议已生成')
    } catch { /* 403/503 拦截器已提示 */ }
  }

  const doAcceptAll = async () => {
    await acceptAll(id)
    toast.success('已全部接受')
  }

  const doExport = async () => {
    try {
      await downloadDocx(id)
    } catch (e) {
      if (e.status === 403 && e.code === 'PLAN_LIMIT') {
        setPaywall(true)
        return
      }
      toast.warning('还没有已接受的修订，请先接受至少一条')
    }
  }

  const doRebut = async (riskId) => {
    if (rebuts[riskId]) {
      setRebutals((m) => ({ ...m, [riskId]: '' }))
      return
    }
    const text = await rebuttal(riskId)
    setRebutals((m) => ({ ...m, [riskId]: text }))
  }

  const regenerateOne = async (riskId, tone) => {
    await regenerate(id, riskId, tone)
    toast.success('已重新生成')
  }

  return (
    <div className={styles.wrap}>
      {/* 工具栏 */}
      <div className={styles.toolbar}>
        <div>
          <h2>{total} 条 AI 修订建议</h2>
          <p>可逐条接受、拒绝或重新生成，满意后导出 Word 红划线修订稿</p>
        </div>
        {deep && generated && (
          <div className={styles.tbRight}>
            <button className="btn btn-ghost" onClick={() => setCompareOpen(true)}>
              <SwapOutlined /> 对比原版
            </button>
            <button className="btn btn-ghost" onClick={doAcceptAll}>全部接受</button>
            <button className="btn btn-primary" onClick={doExport}>
              <FileWordOutlined /> 导出 Word 红划线 <span className={styles.small} style={{ fontWeight: 400 }}>.docx</span>
            </button>
          </div>
        )}
      </div>

      {loading && <div className={styles.panel}><div className={styles.panelBody} style={{ textAlign: 'center' }}><Spin /></div></div>}

      {!loading && total === 0 && (
        <div className={styles.panel}><div className={styles.panelBody} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>
          本次审查未发现风险，无需生成修订稿。
        </div></div>
      )}

      {deep && !loading && total > 0 && !generated && (
        <div className={styles.panel}><div className={styles.panelBody} style={{ textAlign: 'center' }}>
          <EditOutlined style={{ fontSize: 28, color: 'var(--color-primary)' }} />
          <p style={{ margin: '10px 0 14px', color: 'var(--color-text-sub)' }}>
            基于本次 {total} 条风险，一键生成可直接替换进合同的修订条款
          </p>
          <button className="btn btn-primary" disabled={acting} onClick={doGenerate}>一键生成修订稿</button>
        </div></div>
      )}

      <div className={styles.dashCols}>
        {/* 修订卡 */}
        <div>
          {revisions.filter((r) => r.rewritten).map((r, i) => {
            const sev = SEV[r.severity] || SEV.LOW
            const st = STATUS_TAG[r.revisionStatus] || STATUS_TAG.PENDING
            const reasonText = (r.reason || '').replace(/^修改建议：?/, '')
            const acceptedItem = r.revisionStatus === 'ACCEPTED'
            return (
              <div key={r.id} className={`${styles.panel} ${styles.dfItem}`}>
                <div className={styles.panelBody}>
                  <div className={styles.dfHead}>
                    <b>修订 {i + 1} · {r.clauseTitle || '未关联条款'}</b>
                    <span className={`${styles.tag} ${st.cls}`}>{st.text}</span>
                    <span className={`${styles.tag} ${sev.tag}`} style={{ marginLeft: 'auto' }}>{sev.text}</span>
                  </div>
                  <div className={`${styles.dfLine} ${styles.dfOld}`}>
                    <span className={styles.dfLab}>原句</span>
                    <span><del style={{ color: 'var(--color-danger)' }}>{r.quote}</del></span>
                  </div>
                  <div className={`${styles.dfLine} ${styles.dfNew}`}>
                    <span className={styles.dfLab}>改写</span>
                    <span><u style={{ color: '#1d4ed8', textUnderlineOffset: 3 }}>{r.rewritten}</u></span>
                  </div>
                  {reasonText && (
                    <div className={styles.dfReason}>
                      <InfoCircleOutlined style={{ marginTop: 3 }} />
                      <span>理由：{reasonText}</span>
                    </div>
                  )}
                  <div className={styles.dfFoot}>
                    {acceptedItem ? (
                      <>
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(id, r.id, 'PENDING')}>撤销接受</button>
                        <button className={styles.btnText} onClick={() => regenerateOne(r.id, 'NEUTRAL')}>重新生成</button>
                        <span className={`${styles.dfSpacer} ${styles.small} ${styles.muted}`}>已写入修订稿</span>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => setStatus(id, r.id, 'ACCEPTED')}>接受</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setStatus(id, r.id, 'REJECTED')}>拒绝</button>
                        <button className={styles.btnText} onClick={() => regenerateOne(r.id, 'NEUTRAL')}>重新生成</button>
                        <button className={styles.btnText} onClick={() => regenerateOne(r.id, 'FIRM')}>更强硬</button>
                        <button className={styles.btnText} onClick={() => regenerateOne(r.id, 'GENTLE')}>更温和</button>
                        <button className={styles.btnText} onClick={() => doRebut(r.id)}>
                          {rebuts[r.id] ? '收起反驳' : '模拟对方反驳'}
                        </button>
                      </>
                    )}
                  </div>
                  {rebuts[r.id] && (
                    <div className={styles.dfRebut}>
                      <b>模拟对方反驳：</b>「{rebuts[r.id]}」
                      <div className={`${styles.small} ${styles.muted}`} style={{ marginTop: 6 }}>
                        建议回应：援引法条强调对方法定义务，并提出折中方案；可点击「更强硬 / 更温和」换一版措辞。
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 右栏：改稿说明 */}
        <div className={styles.panel}>
          <div className={styles.panelHead}><h3>改稿说明</h3></div>
          <div className={styles.panelBody}>
            <div className={`${styles.small} ${styles.muted}`}>已接受修订</div>
            <div style={{ fontSize: 24, fontWeight: 800, margin: '2px 0' }}>
              {accepted} <span style={{ fontSize: 14, color: 'var(--color-text-muted)', fontWeight: 400 }}>/ {total}</span>
            </div>
            <div className={styles.progress}><i style={{ width: `${total ? Math.round((accepted / total) * 100) : 0}%` }} /></div>
            <div className={`${styles.banner} ${styles.bannerInfo}`} style={{ marginTop: 14 }}>
              <InfoCircleOutlined style={{ flex: 'none', marginTop: 2 }} />
              <div>接受全部后可导出 Word 红划线修订稿，对方打开即可看到所有改动痕迹。</div>
            </div>
            <ul className={styles.tipList}>
              <li><span className={styles.tick}><CheckOutlined /></span><span>接受的修订自动写入 .docx 修订模式</span></li>
              <li><span className={styles.tick}><CheckOutlined /></span><span>拒绝的条款保留原文，不影响其他修订</span></li>
              <li><span className={styles.tick}><CheckOutlined /></span><span>可对任意一条「重新生成」，换一版措辞</span></li>
              <li><span className={styles.tick}><CheckOutlined /></span><span>「模拟对方反驳」帮你提前准备谈判话术</span></li>
            </ul>
            <div style={{ borderTop: '1px solid var(--color-border-light)', marginTop: 16, paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Link to={`/review/${id}`} className="btn btn-ghost" style={{ textAlign: 'center' }}>返回审查结果</Link>
              <Link to="/my-contracts" className={styles.small} style={{ textAlign: 'center' }}>查看我的合同</Link>
            </div>
          </div>
        </div>
      </div>

      {/* 对比原版 */}
      <Modal
        open={compareOpen}
        title="对比原版（红划线预览）"
        footer={null}
        width={820}
        onCancel={() => setCompareOpen(false)}
        transitionName=""
        maskTransitionName=""
      >
        <div className={styles.compare}>
          <div>
            <h5 style={{ fontSize: 13, marginBottom: 8 }}><span className={`${styles.tag} ${styles.tagRed}`}>原版</span></h5>
            <div className={styles.compareCol}>
              {revisions.filter((r) => r.rewritten).map((r, i) => (
                <div key={r.id} style={{ marginBottom: 12 }}>
                  <b>{r.clauseTitle || `修订 ${i + 1}`}</b><br />
                  <del style={{ color: 'var(--color-danger)' }}>{r.quote}</del>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h5 style={{ fontSize: 13, marginBottom: 8 }}>
              <span className={`${styles.tag} ${styles.tagGreen}`}>AI 修订稿</span> 已接受 {accepted} 条
            </h5>
            <div className={styles.compareCol}>
              {revisions.filter((r) => r.rewritten).map((r, i) => (
                <div key={r.id} style={{ marginBottom: 12 }}>
                  <b>{r.clauseTitle || `修订 ${i + 1}`}</b><br />
                  {r.revisionStatus === 'ACCEPTED'
                    ? <u style={{ color: '#1d4ed8' }}>{r.rewritten}</u>
                    : <span style={{ color: 'var(--color-text-muted)' }}>{r.rewritten}（未接受）</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* FREE 整页遮罩 */}
      {!deep && !loading && (
        <div className={styles.dfLockMask}>
          <div className={styles.dfLockBox}>
            <div className={styles.dfLockIc}><LockOutlined style={{ fontSize: 30 }} /></div>
            <h3>AI 多轮改稿为个人版权益</h3>
            <p>
              开通个人版（¥19/月 或 ¥99/年）即可使用逐条改稿、模拟反驳与 Word 红划线导出；
              也可使用 1 张深度审查券（¥9.9）解锁本份合同的改稿。
            </p>
            <div className={styles.dfLockBtns}>
              <button className="btn btn-primary" onClick={() => navigate('/checkout?plan=PERSONAL&period=monthly')}>开通个人版</button>
              <button className="btn btn-ghost" onClick={() => setPaywall(true)}>使用深度券 ¥9.9</button>
            </div>
            <div style={{ marginTop: 14 }}>
              <Link to={`/review/${id}`} className={`${styles.small} ${styles.muted}`}>
                <ArrowLeftOutlined /> 返回免费审查结果
              </Link>
            </div>
          </div>
        </div>
      )}

      <Paywall
        open={paywall}
        onClose={() => setPaywall(false)}
        couponBalance={couponBalance}
        onUseCoupon={unlockWithCoupon}
        description="深度券与个人版均可解锁本份合同的 AI 多轮改稿与 Word 红划线导出。"
        cancelText="暂不解锁"
      />
    </div>
  )
}
