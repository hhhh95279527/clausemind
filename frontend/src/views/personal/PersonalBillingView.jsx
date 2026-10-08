// frontend/src/views/personal/PersonalBillingView.jsx
// 我的订阅（personal-billing 原型 #top/#paid/#cancel）：
// 当前套餐卡（FREE / PERSONAL 两态）+ 升级与加购（月付/年付/券包）+ 订单记录 + 团队引导。
// 文案以 docs/prototype/personal-billing.html 为唯一来源。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Modal } from 'antd'
import {
  CheckOutlined, ClockCircleOutlined, ExclamationCircleFilled,
  ThunderboltFilled, TagOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useMeStore } from '@/stores/me.js'
import { useBillingStore } from '@/stores/billing.js'
import { useAppStore } from '@/stores/app.js'
import css from './personal.module.css'

const ORDER_GOODS = {
  PERSONAL_MONTHLY: '个人版月付',
  PERSONAL_YEARLY: '个人版年付',
  COUPON_PACK: '深度审查券包 × 10',
  TEAM_MONTHLY: '团队版月付（5 席位）',
}

function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function fmtDateTime(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const PLAN_CARDS = [
  {
    key: 'monthly',
    name: '个人版 · 月付',
    desc: '适合短期集中签约的月份，随时取消',
    price: '¥19',
    per: ' / 月',
    feats: [
      '不限份数审查，长文档不限字数',
      'AI 语义审查 + 法条依据 + 修改建议',
      '多轮追问、AI 改稿、模拟反驳',
      'Word 红划线导出 · 永久存档 · 条款库',
    ],
    to: '/checkout?plan=PERSONAL&period=monthly',
    btn: '选择月付',
  },
  {
    key: 'yearly',
    name: '个人版 · 年付',
    desc: '相当于 ¥8.25/月，权益与月付完全一致',
    price: '¥99',
    per: ' / 年',
    flag: '最划算',
    cornerTag: '省 48%',
    feats: [
      '不限份数审查，长文档不限字数',
      'AI 语义审查 + 法条依据 + 修改建议',
      '多轮追问、AI 改稿、模拟反驳',
      'Word 红划线导出 · 永久存档 · 条款库',
    ],
    to: '/checkout?plan=PERSONAL&period=yearly',
    btn: '选择年付',
  },
  {
    key: 'coupons',
    name: '深度审查券包',
    desc: '不开通订阅，按份解锁，1 券 = 1 份深度审查',
    price: '¥99',
    per: ' / 10 张（¥9.9/份）',
    feats: [
      '1 券解锁 1 份深度审查，含长文档',
      '支持非标合同（借款 / 合作 / 买卖等）',
      '含 AI 改稿与 Word 红划线导出',
    ],
    offFeat: '无份数不限量与条款库权益',
    to: '/checkout?item=COUPON_PACK',
    btn: '购买券包',
    ghost: true,
  },
]

export default function PersonalBillingView() {
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)
  const { entitlement, loadEntitlement } = useMeStore()
  const { orders, loadOrders, cancelSubscription } = useBillingStore()
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const plansRef = useRef(null)

  useEffect(() => {
    loadEntitlement()
    loadOrders()
  }, [loadEntitlement, loadOrders])

  const isPaid = entitlement?.plan === 'PERSONAL'
  const isTeamSpace = entitlement?.workspaceType === 'TEAM'

  const latestPersonalPaid = useMemo(
    () => orders.find((o) => o.status === 'PAID' && (o.item === 'PERSONAL_MONTHLY' || o.item === 'PERSONAL_YEARLY')),
    [orders],
  )
  const periodLabel = latestPersonalPaid?.period === 'YEAR' ? '年付套餐' : '月付套餐'

  const doCancel = async () => {
    setCancelling(true)
    try {
      await cancelSubscription()
      await loadEntitlement()
      setCancelOpen(false)
      toast.success('已设置到期取消，到期前可继续使用个人版')
    } finally {
      setCancelling(false)
    }
  }

  // 团队空间（TEAM/ENTERPRISE）误入个人订阅页：引导去企业账单页
  if (isTeamSpace) {
    return (
      <div className={css.wrap}>
        <div className={css.panel}>
          <div className={css.panelBody} style={{ textAlign: 'center', padding: '48px 20px' }}>
            <TeamOutlined style={{ fontSize: 34, color: 'var(--color-primary)' }} />
            <h2 style={{ fontSize: 18, margin: '14px 0 6px' }}>当前为团队空间</h2>
            <p className={`${css.muted} ${css.small}`} style={{ marginBottom: 18 }}>
              团队席位与企业版套餐请在企业「我的套餐」中查看。
            </p>
            <Button type="primary" onClick={() => navigate('/billing')}>前往企业套餐页</Button>
          </div>
        </div>
      </div>
    )
  }

  const quota = entitlement?.monthlyReviewQuota ?? 2
  const used = entitlement?.usedReviews ?? 0
  const usagePct = Math.min(100, Math.round((used / Math.max(1, quota)) * 100))

  return (
    <div className={css.wrap}>
      {/* ── 当前套餐 ── */}
      <section className={css.panel}>
        <div className={`${css.panelBody} ${css.pbCurrent}`}>
          <div className={`${css.pbBadge} ${isPaid ? css.pbBadgePaid : ''}`}>
            {isPaid ? <CheckOutlined /> : <ThunderboltFilled />}
          </div>

          <div className={css.pbInfo}>
            {!isPaid ? (
              <>
                <div className={css.pbPlanName}>免费版 FREE</div>
                <div className={css.pbPlanSub}>
                  每月 2 份 · 每份 ≤ 3000 字 · 劳动 / 租赁 / 劳务 / NDA · 记录保留 7 天
                </div>
                <div className={css.pbUsage}>
                  <div className={css.pbUsageRow}>
                    <span>本月免费额度</span>
                    <b style={{ color: 'var(--color-text)' }}>{used} / {quota} 份</b>
                  </div>
                  <div className={css.progress}><i style={{ width: `${usagePct}%` }} /></div>
                  <div className={css.pbUsageRow} style={{ marginTop: 12 }}>
                    <span>长文档 / 非标合同</span>
                    <span>需深度券或个人版</span>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className={css.pbPlanName}>
                  个人版 PERSONAL <span className={`${css.tag} ${css.tagGreen}`} style={{ verticalAlign: 4 }}>使用中</span>
                </div>
                <div className={css.pbPlanSub}>
                  {periodLabel} · 有效期至 {fmtDate(entitlement.planExpiresAt)} · 到期前可随时续费
                </div>
                <div className={css.pbUsage}>
                  <div className={css.pbUsageRow}>
                    <span>本月审查份数</span>
                    <b style={{ color: 'var(--color-text)' }}>{used} 份 · 不限份数</b>
                  </div>
                  <div className={css.progress}><i style={{ width: '100%', background: 'var(--color-success)' }} /></div>
                  <div className={css.pbUsageRow} style={{ marginTop: 12 }}>
                    <span>权益</span>
                    <span>AI 改稿 · Word 红划线 · 永久存档 · 个人条款库</span>
                  </div>
                </div>
              </>
            )}
          </div>

          <div className={css.pbSide}>
            <div className={css.pbCoupon}>
              <TagOutlined style={{ color: 'var(--color-warning)' }} />
              <span>深度券余额</span>
              <b style={{ marginLeft: 'auto' }}>{entitlement?.couponBalance ?? 0} 张</b>
            </div>
            {!isPaid ? (
              <>
                <Button type="primary" block onClick={() => plansRef.current?.scrollIntoView({ behavior: 'smooth' })}>
                  升级个人版
                </Button>
                <Button block onClick={() => navigate('/checkout?item=COUPON_PACK')}>
                  购买深度券 ¥9.9/份
                </Button>
              </>
            ) : (
              <Button block danger={false} onClick={() => setCancelOpen(true)}>
                取消订阅（模拟）
              </Button>
            )}
          </div>
        </div>
        {isPaid && entitlement?.cancelAtPeriodEnd && (
          <div className={`${css.banner} ${css.bannerWarn}`} style={{ margin: '0 18px 16px' }}>
            <ClockCircleOutlined style={{ flex: 'none', marginTop: 2 }} />
            <span>
              已设置到期取消：个人版权益保留至 {fmtDate(entitlement.planExpiresAt)}，到期后恢复免费版。
            </span>
          </div>
        )}
      </section>

      {/* ── 升级与加购 ── */}
      <div ref={plansRef}>
        <h3 className={css.pbSectionTitle}>升级与加购</h3>
        <p className={css.pbSectionSub}>
          个人使用推荐年付，相当于每月 8.25 元；偶尔审长文档可只买深度券。
        </p>
        <div className={css.pbPlanGrid}>
          {PLAN_CARDS.map((c) => (
            <div key={c.key} className={`${css.planCard} ${c.flag ? css.planCardFeatured : ''}`}>
              {c.flag && <div className={css.planFlag}>{c.flag}</div>}
              {c.cornerTag && <span className={`${css.tag} ${css.tagGreen} ${css.pbCardTag}`}>{c.cornerTag}</span>}
              <div className={css.planCardName}>{c.name}</div>
              <div className={css.planCardDesc}>{c.desc}</div>
              <div className={css.planCardPrice}>
                {c.price}<small className={css.pbPer}> {c.per}</small>
              </div>
              <ul className={css.planFeats}>
                {c.feats.map((f) => (
                  <li key={f}><span className={css.tick}>✓</span>{f}</li>
                ))}
                {c.offFeat && (
                  <li className={css.featOff}><span className={css.tick}>✓</span>{c.offFeat}</li>
                )}
              </ul>
              <Button
                type={c.ghost ? 'default' : 'primary'}
                block
                onClick={() => navigate(c.to)}
              >
                {c.btn}
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* ── 订单记录 + 团队引导 ── */}
      <div className={css.dashCols}>
        <div className={css.panel}>
          <div className={css.panelHead}>
            <h3>订单记录</h3>
            <div className={css.phRight}>
              <span className={`small muted ${css.small} ${css.muted}`}>近 {orders.length} 条</span>
            </div>
          </div>
          <table className={css.tbl}>
            <thead>
              <tr><th>订单号</th><th>商品</th><th>金额</th><th>状态</th><th>下单时间</th></tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr><td colSpan={5} className={`${css.muted} ${css.small}`}>暂无订单记录</td></tr>
              )}
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.orderNo}</td>
                  <td>{ORDER_GOODS[o.item] || o.item}</td>
                  <td>{o.status === 'PAID' ? <b>¥{o.amountYuan}</b> : <span className={css.muted}>¥{o.amountYuan}</span>}</td>
                  <td>
                    {o.status === 'PAID' && <span className={`${css.tag} ${css.tagGreen}`}>已支付</span>}
                    {o.status === 'PENDING' && <span className={`${css.tag} ${css.tagOrange}`}>待支付</span>}
                    {o.status === 'CANCELLED' && <span className={`${css.tag} ${css.tagGray}`}>已取消</span>}
                  </td>
                  <td className={`${css.small} ${css.muted}`}>{fmtDateTime(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className={css.panel}>
          <div className={css.panelHead}><h3>需要团队协作？</h3></div>
          <div className={css.panelBody}>
            <p className={`${css.small} ${css.muted}`} style={{ lineHeight: 1.9 }}>
              如果你和同事需要<b style={{ color: 'var(--color-text)' }}>共享合同库、统一审查规则（Playbook）、审批流与企业级管理后台</b>，ClauseMind 提供团队版与企业版，支持成员席位、合同台账与操作审计。
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
              <Button type="primary" block onClick={() => navigate('/pricing')}>了解团队版</Button>
              <Button block onClick={() => navigate('/dashboard')}>预览企业工作台</Button>
            </div>
            <div className={`${css.small} ${css.muted}`} style={{ marginTop: 12, lineHeight: 1.8 }}>
              TEAM 套餐适合 3–20 人小团队；ENTERPRISE 支持 SSO、私有化部署与定制规则。
            </div>
          </div>
        </div>
      </div>

      {/* ── 取消订阅二次确认 ── */}
      <Modal
        open={cancelOpen}
        title="确认取消个人版？"
        onCancel={() => setCancelOpen(false)}
        width={460}
        centered
        transitionName=""
        maskTransitionName=""
        footer={[
          <Button key="back" onClick={() => setCancelOpen(false)}>我再想想</Button>,
          <Button key="ok" danger type="primary" loading={cancelling} onClick={doCancel}>确认取消</Button>,
        ]}
      >
        <div className={`${css.banner} ${css.bannerWarn}`} style={{ marginBottom: 12 }}>
          <ExclamationCircleFilled style={{ flex: 'none', marginTop: 2 }} />
          <div>演示操作，不会产生真实变更。</div>
        </div>
        <p className={css.small} style={{ lineHeight: 1.9, color: 'var(--color-text-sub)' }}>
          取消后，个人版权益将保留至 <b style={{ color: 'var(--color-text)' }}>{fmtDate(entitlement?.planExpiresAt)}</b>；到期后账户恢复为 FREE：每月 2 份免费额度、深度内容加锁、新记录仅保留 7 天。已存档合同与条款库可导出。
        </p>
      </Modal>
    </div>
  )
}
