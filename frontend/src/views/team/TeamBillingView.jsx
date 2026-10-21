// frontend/src/views/team/TeamBillingView.jsx
// 「我的套餐」（Phase 5 / FR-13）：当前套餐 + 用量 + 订单记录 + 席位增购/企业版留资。
// 2026-10 起个人/企业同构：个人空间渲染个人套餐卡（FREE/PERSONAL）+ 升级/续费/取消订阅；
// 个人空间另展示「更多套餐」（团队版 / 企业版），讲解升级路径与企业版作用。
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { App, Button, Form, Input, Modal, Select } from 'antd'
import {
  CheckCircleFilled, CrownFilled, NotificationOutlined, SafetyOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useMeStore } from '@/stores/me.js'
import { useBillingStore } from '@/stores/billing.js'
import { useAppStore } from '@/stores/app.js'
import { useRefundStore } from '@/stores/refund.js'
import RefundDrawer from './RefundDrawer.jsx'
import { FREE_LIMITS } from '@/config/plans.js'
import css from '../personal/personal.module.css'

const ORDER_GOODS = {
  PERSONAL_MONTHLY: '个人版月付',
  PERSONAL_YEARLY: '个人版年付',
  COUPON_PACK: '深度审查券包 × 10',
  TEAM_MONTHLY: '团队版月付（5 席位）',
}

function fmtDateTime(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtDate(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const TEAM_FEATS = [
  'Playbook 公司红线规则与行业风险包',
  '团队共享合同库、审批流与操作审计',
  '合同全生命周期台账（不限条数）',
  '飞书群通知与深度 AI 审查 / 改稿 / 导出',
]

const PERSONAL_FEATS = [
  '不限份数审查，长文档不限字数',
  'AI 语义审查 + 法条依据 + 修改建议',
  '多轮追问、AI 改稿、模拟反驳',
  'Word 红划线导出 · 永久存档',
]

const FREE_FEATS = [
  '每月 2 份免费审查 · 单份 ≤ 3000 字',
  '五类高频合同场景（劳动 / 实习 / 租赁 / 劳务 / NDA）',
  '风险点 · 大白话摘要 · 风险评分',
  '审查记录保留 7 天',
]

export default function TeamBillingView() {
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)
  // 购买入口关闭（ICP 备案审核期）：升级/续费按钮不进入收银台
  const paymentEnabled = useAppStore((s) => s.paymentEnabled)
  const blockedCta = () => toast('内测阶段，暂未开放购买')
  const { modal } = App.useApp()
  const { entitlement, loadEntitlement } = useMeStore()
  const { orders, loadOrders, submitEnterpriseLead, cancelSubscription } = useBillingStore()
  const { requests: refundRequests, loadMine: loadRefunds } = useRefundStore()
  const [leadOpen, setLeadOpen] = useState(false)
  const [leadKind, setLeadKind] = useState('ENTERPRISE')
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()
  // 退款抽屉：从订单行「申请退款」进入；已有工单直接看进度
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundOrder, setRefundOrder] = useState(null)
  const [refundRequestId, setRefundRequestId] = useState(null)

  useEffect(() => {
    loadEntitlement()
    loadOrders()
    loadRefunds().catch(() => {})
  }, [loadEntitlement, loadOrders, loadRefunds])

  // 订单 → 已有退款工单（用于「已申请」标记）
  const refundByOrder = Object.fromEntries(refundRequests.map((r) => [r.orderId, r]))

  const openRefund = (o) => {
    setRefundOrder(o)
    setRefundOpen(true)
  }

  const isTeamSpace = entitlement?.workspaceType === 'TEAM'
  const isEnterprise = entitlement?.plan === 'ENTERPRISE'
  const isPaidPersonal = entitlement?.plan === 'PERSONAL'
  const seats = entitlement?.seats
  const usedSeats = entitlement?.usedSeats ?? 0
  const quota = entitlement?.monthlyReviewQuota ?? FREE_LIMITS.monthlyReviews
  const usedReviews = entitlement?.usedReviews ?? 0
  const usagePct = Math.min(100, Math.round((usedReviews / Math.max(1, quota)) * 100))
  const couponBalance = entitlement?.couponBalance ?? 0

  const openLead = (kind) => {
    setLeadKind(kind)
    form.setFieldsValue({
      teamSize: '6-20',
      note: kind === 'SEATS' ? '希望增购团队席位' : '希望了解企业版（SSO / 私有化 / 定制规则）',
    })
    setLeadOpen(true)
  }

  const doSubmit = async () => {
    const v = await form.validateFields()
    setSubmitting(true)
    try {
      await submitEnterpriseLead(v)
      setLeadOpen(false)
      form.resetFields()
      toast.success('咨询已提交，我们会尽快与你联系')
    } finally {
      setSubmitting(false)
    }
  }

  // 个人版订阅：到期取消（保留权益至 planExpiresAt）
  const confirmCancel = () => {
    modal.confirm({
      title: '取消个人版订阅？',
      content: '取消后本周期结束（到期）权益自动失效，到期前可继续使用全部个人版权益。',
      okText: '确认取消订阅',
      okButtonProps: { danger: true },
      cancelText: '再想想',
      onOk: async () => {
        await cancelSubscription()
        await loadEntitlement()
        toast.success('已设置到期取消，到期前可继续使用个人版')
      },
    })
  }

  // 「更多套餐」：展示当前套餐之外的升级路径（仅个人空间），重点讲解企业版作用
  const showcasePlans = [
    ...(isPaidPersonal || isTeamSpace || isEnterprise ? [] : [{
      key: 'PERSONAL',
      icon: <SafetyOutlined style={{ color: 'var(--color-primary)' }} />,
      name: '个人版 PERSONAL',
      price: '¥0.01 / 月 · 年付同样 ¥0.01',
      priceCls: css.tagGreen,
      desc: '适合个人与自由职业者：不限份数深度审查、AI 改稿与模拟反驳、Word 红划线导出、永久存档。',
      cta: '升级个人版',
      onCta: paymentEnabled ? () => navigate('/checkout?plan=PERSONAL&period=monthly') : blockedCta,
    }]),
    {
      key: 'TEAM',
      icon: <TeamOutlined style={{ color: 'var(--color-primary)' }} />,
      name: '团队版 TEAM',
      price: '¥0.01 / 席 / 月（5 席位起）',
      priceCls: css.tagGreen,
      desc: '适合 3 人以上小团队：共享合同库与审批流、公司红线规则（Playbook）、不限条数台账、飞书群通知。',
      cta: '升级团队版',
      onCta: paymentEnabled ? () => navigate('/checkout?plan=TEAM&period=monthly') : blockedCta,
    },
    {
      key: 'ENTERPRISE',
      icon: <CrownFilled style={{ color: 'var(--color-primary)' }} />,
      name: '企业版 ENTERPRISE',
      price: '定制报价',
      priceCls: css.tagPurple,
      desc: '适合有法务/合规团队的中大型企业，把公司整套审查标准搬进 ClauseMind：',
      feats: [
        '不限席位，组织 / 角色 / 权限集中管理',
        'SSO 单点登录 · 私有化部署，数据不出企业内网',
        '定制审查规则：专属 Playbook 与行业专项规则包',
        'API 对接 OA / 合同系统，审查能力嵌入业务流程',
        '专属商务与客户成功，支持采购合同与发票',
      ],
      cta: '联系开通企业版',
      onCta: () => openLead('ENTERPRISE'),
    },
  ]

  return (
    <div className={css.wrap}>
      <section className={css.panel}>
        <div className={`${css.panelBody} ${css.pbCurrent}`}>
          <div className={`${css.pbBadge} ${isEnterprise || isPaidPersonal ? css.pbBadgePaid : ''}`}>
            {isTeamSpace ? <TeamOutlined /> : <SafetyOutlined />}
          </div>
          <div className={css.pbInfo}>
            <div className={css.pbPlanName}>
              {isEnterprise ? '企业版 ENTERPRISE' : isTeamSpace ? '团队版 TEAM' : isPaidPersonal ? '个人版 PERSONAL' : '免费版 FREE'}
              <span className={`${css.tag} ${css.tagGreen}`} style={{ verticalAlign: 4, marginLeft: 8 }}>使用中</span>
            </div>
            <div className={css.pbPlanSub}>
              {isEnterprise
                ? '定制套餐 · 不限席位 · SSO / 私有化 / 定制规则'
                : isTeamSpace
                  ? `月付套餐 · ¥0.01/席/月 · ${entitlement?.planExpiresAt ? `有效期至 ${fmtDate(entitlement.planExpiresAt)}` : ''}`
                  : isPaidPersonal
                    ? `已解锁全部深度权益 · 不限份数${entitlement?.planExpiresAt ? ` · 有效期至 ${fmtDate(entitlement.planExpiresAt)}` : ''}`
                    : '每月免费额度 · 单份 ≤ 3000 字 · 审查记录保留 7 天'}
            </div>
            <div className={css.pbUsage}>
              <div className={css.pbUsageRow}>
                <span>{isTeamSpace ? '席位用量' : '本月审查'}</span>
                <b style={{ color: 'var(--color-text)' }}>
                  {isTeamSpace
                    ? <>{usedSeats} / {seats === null || seats === undefined ? '不限' : seats} 席</>
                    : <>{usedReviews} / {quota} 份</>}
                </b>
              </div>
              {isTeamSpace ? (
                seats && (
                  <div className={css.progress}>
                    <i style={{ width: `${Math.min(100, Math.round((usedSeats / seats) * 100))}%` }} />
                  </div>
                )
              ) : (
                <div className={css.progress}>
                  <i style={{ width: `${usagePct}%` }} />
                </div>
              )}
              <div className={css.pbUsageRow} style={{ marginTop: 12 }}>
                <span>权益</span>
                <span>
                  {isTeamSpace
                    ? 'Playbook 红线 · 团队审批 · 不限台账 · 飞书通知'
                    : isPaidPersonal
                      ? '深度审查 · AI 改稿 · 红划线导出 · 永久存档'
                      : '风险点 · 大白话摘要 · 风险评分'}
                </span>
              </div>
            </div>
          </div>
          <div className={css.pbSide}>
            <div className={css.pbCoupon}>
              <TeamOutlined style={{ color: 'var(--color-primary)' }} />
              <span>{isTeamSpace ? '本月审查' : '深度券余额'}</span>
              <b style={{ marginLeft: 'auto' }}>
                {isTeamSpace ? `${entitlement?.usedReviews ?? 0} 份 · 不限` : `${couponBalance} 张`}
              </b>
            </div>
            {isTeamSpace ? (
              <>
                {!isEnterprise && <Button block onClick={() => openLead('SEATS')}>增购席位</Button>}
                <Button type="primary" block onClick={() => openLead(isEnterprise ? 'SEATS' : 'ENTERPRISE')}>
                  {isEnterprise ? '联系商务' : '联系开通企业版'}
                </Button>
              </>
            ) : isPaidPersonal ? (
              <>
                <Button type="primary" block onClick={paymentEnabled ? () => navigate('/checkout?plan=PERSONAL&period=yearly') : blockedCta}>续费个人版</Button>
                <Button block danger onClick={confirmCancel}>取消订阅</Button>
              </>
            ) : (
              <>
                <Button type="primary" block onClick={paymentEnabled ? () => navigate('/checkout?plan=PERSONAL&period=monthly') : blockedCta}>
                  {paymentEnabled ? '升级个人版 ¥0.01/月' : '升级个人版'}
                </Button>
                {paymentEnabled && <Button block onClick={() => navigate('/checkout?plan=PERSONAL&period=yearly')}>年付 ¥0.01</Button>}
              </>
            )}
          </div>
        </div>
      </section>

      <div className={css.grid2}>
        <div className={css.panel}>
          <div className={css.panelHead}><h3>套餐权益</h3></div>
          <div className={css.panelBody}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(isTeamSpace ? TEAM_FEATS : isPaidPersonal ? PERSONAL_FEATS : FREE_FEATS).map((f) => (
                <li key={f} style={{ display: 'flex', gap: 9, fontSize: 13.5, alignItems: 'flex-start' }}>
                  <span style={{
                    color: 'var(--color-success)', flex: 'none', width: 18, height: 18,
                    borderRadius: '50%', background: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11,
                  }}>
                    <CheckCircleFilled />
                  </span>
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className={css.panel}>
          <div className={css.panelHead}>
            <h3>订单记录</h3>
            <span className={`${css.small} ${css.muted}`}>已支付订单可申请退款（每笔限一次）</span>
          </div>
          <table className={css.tbl}>
            <thead>
              <tr><th>订单号</th><th>商品</th><th>金额</th><th>状态</th><th>下单时间</th><th style={{ width: 90 }}>操作</th></tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr><td colSpan={6} className={`${css.muted} ${css.small}`}>暂无订单记录</td></tr>
              )}
              {orders.map((o) => {
                const refund = refundByOrder[o.id]
                return (
                  <tr key={o.id}>
                    <td>{o.orderNo}</td>
                    <td>{ORDER_GOODS[o.item] || o.item}</td>
                    <td>{o.status === 'PAID' ? <b>¥{o.amountYuan}</b> : <span className={css.muted}>¥{o.amountYuan}</span>}</td>
                    <td>
                      {o.status === 'PAID' && <span className={`${css.tag} ${css.tagGreen}`}>已支付</span>}
                      {o.status === 'PENDING' && <span className={`${css.tag} ${css.tagOrange}`}>待支付</span>}
                      {o.status === 'CANCELLED' && <span className={`${css.tag} ${css.tagGray}`}>已取消</span>}
                      {o.status === 'REFUNDED' && <span className={`${css.tag} ${css.tagGray}`}>已退款</span>}
                    </td>
                    <td className={`${css.small} ${css.muted}`}>{fmtDateTime(o.createdAt)}</td>
                    <td>
                      {refund ? (
                        <button
                          type="button"
                          className={`${css.small} ${css.tag}`}
                          style={{
                            border: 'none', cursor: 'pointer', padding: '2px 8px',
                            background: refund.status === 'RESOLVED' && refund.resolution === 'REJECTED'
                              ? 'color-mix(in srgb, var(--color-danger, #ff4d4f) 10%, transparent)'
                              : 'color-mix(in srgb, var(--color-primary) 10%, transparent)',
                          }}
                          onClick={() => { setRefundRequestId(refund.id); setRefundOrder(null); setRefundOpen(true) }}
                        >
                          {refund.status === 'RESOLVED'
                            ? (refund.resolution === 'APPROVED' ? '已退款' : '未通过')
                            : '退款进度'}
                        </button>
                      ) : o.status === 'PAID' ? (
                        <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openRefund(o)}>
                          申请退款
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* 退款抽屉：表单 → AI 客服会话 → 转人工 */}
      <RefundDrawer
        open={refundOpen}
        onClose={() => {
          setRefundOpen(false)
          setRefundRequestId(null)
          loadRefunds().catch(() => {})
          loadOrders()
        }}
        initialOrder={refundOrder}
        initialRequestId={refundRequestId}
      />

      {/* 更多套餐：升级路径与企业版讲解（仅个人空间展示） */}
      {!isTeamSpace && showcasePlans.length > 0 && (
        <div className={css.panel}>
          <div className={css.panelHead}>
            <h3>更多套餐</h3>
            <span className={`${css.small} ${css.muted}`}>随团队规模平滑升级，审查数据全部保留</span>
          </div>
          <div className={css.panelBody}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(270px, 1fr))', gap: 14 }}>
              {showcasePlans.map((p) => (
                <div
                  key={p.key}
                  style={{
                    border: p.key === 'ENTERPRISE'
                      ? '1.5px solid color-mix(in srgb, var(--color-primary) 35%, transparent)'
                      : '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '16px 18px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {p.icon}
                    <b style={{ fontSize: 14.5 }}>{p.name}</b>
                    <span className={`${css.tag} ${p.priceCls}`} style={{ marginLeft: 'auto' }}>{p.price}</span>
                  </div>
                  <p className={css.muted} style={{ fontSize: 12.8, lineHeight: 1.7, margin: 0 }}>{p.desc}</p>
                  {p.feats && (
                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {p.feats.map((f) => (
                        <li key={f} style={{ display: 'flex', gap: 8, fontSize: 12.8, alignItems: 'flex-start' }}>
                          <span style={{
                            color: 'var(--color-success)', flex: 'none', width: 16, height: 16,
                            borderRadius: '50%', background: 'color-mix(in srgb, var(--color-success) 14%, transparent)',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10,
                          }}>
                            <CheckCircleFilled />
                          </span>
                          {f}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div style={{ marginTop: 'auto', paddingTop: 4 }}>
                    <Button
                      block
                      type={p.key === 'ENTERPRISE' ? 'primary' : 'default'}
                      onClick={p.onCta}
                    >
                      {p.cta}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className={css.panel}>
        <div className={css.panelBody}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <NotificationOutlined style={{ fontSize: 20, color: 'var(--color-primary)', marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <h3 style={{ fontSize: 14.5, marginBottom: 4 }}>需要更多能力？</h3>
              <p className={`${css.small} ${css.muted}`} style={{ lineHeight: 1.8, marginBottom: 12 }}>
                企业版支持 SSO 单点登录、私有化部署、定制审查规则与 API 对接；席位增购与企业版均可通过右侧留资联系商务。
              </p>
              <Button type="primary" onClick={() => openLead(leadKind)}>
                {isEnterprise ? '联系商务' : '席位增购 / 企业版咨询'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal
        open={leadOpen}
        title={leadKind === 'SEATS' ? '席位增购咨询' : '开通企业版咨询'}
        onCancel={() => setLeadOpen(false)}
        width={480}
        centered
        transitionName=""
        maskTransitionName=""
        confirmLoading={submitting}
        okText="提交咨询"
        onOk={doSubmit}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="company" label="公司名称" rules={[{ required: true, message: '请填写公司名称' }]}>
            <Input placeholder="例如：北京某某科技有限公司" maxLength={100} />
          </Form.Item>
          <Form.Item name="contact" label="联系方式（手机 / 邮箱）" rules={[{ required: true, message: '请填写联系方式' }]}>
            <Input placeholder="便于商务与你联系" maxLength={100} />
          </Form.Item>
          <Form.Item name="teamSize" label="团队规模">
            <Select
              options={[
                { value: '1-5', label: '1–5 人' },
                { value: '6-20', label: '6–20 人' },
                { value: '21-50', label: '21–50 人' },
                { value: '50+', label: '50 人以上' },
              ]}
            />
          </Form.Item>
          <Form.Item name="note" label="需求备注">
            <Input.TextArea rows={3} maxLength={500} placeholder="席位数量 / 期望功能 / 上线时间" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
