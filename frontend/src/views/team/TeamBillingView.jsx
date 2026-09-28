// frontend/src/views/team/TeamBillingView.jsx
// 企业空间「我的套餐」（Phase 5 / FR-13）：当前套餐 + 席位用量 + 订单记录 + 席位增购/企业版留资。
// 留资仅写审计日志（ORDER 不支持企业版定制价），由商务（模拟）跟进。
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Form, Input, Modal, Select } from 'antd'
import {
  CheckCircleFilled, NotificationOutlined, SafetyOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useMeStore } from '@/stores/me.js'
import { useBillingStore } from '@/stores/billing.js'
import { useAppStore } from '@/stores/app.js'
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

export default function TeamBillingView() {
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)
  const { entitlement, loadEntitlement } = useMeStore()
  const { orders, loadOrders, submitEnterpriseLead } = useBillingStore()
  const [leadOpen, setLeadOpen] = useState(false)
  const [leadKind, setLeadKind] = useState('ENTERPRISE')
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  useEffect(() => {
    loadEntitlement()
    loadOrders()
  }, [loadEntitlement, loadOrders])

  const isTeamSpace = entitlement?.workspaceType === 'TEAM'
  const isEnterprise = entitlement?.plan === 'ENTERPRISE'
  const seats = entitlement?.seats
  const usedSeats = entitlement?.usedSeats ?? 0

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
      toast.success('已提交，演示环境将由专人（模拟）与你联系')
    } finally {
      setSubmitting(false)
    }
  }

  // 个人空间误入：引导回个人订阅 / 团队升级入口（Phase 6 /team 完整引导）
  if (entitlement && !isTeamSpace) {
    return (
      <div className={css.wrap}>
        <div className={css.panel}>
          <div className={css.panelBody} style={{ textAlign: 'center', padding: '48px 20px' }}>
            <TeamOutlined style={{ fontSize: 34, color: 'var(--color-primary)' }} />
            <h2 style={{ fontSize: 18, margin: '14px 0 6px' }}>当前为个人空间</h2>
            <p className={`${css.muted} ${css.small}`} style={{ marginBottom: 18 }}>
              团队席位与企业套餐属于团队空间能力。
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <Button onClick={() => navigate('/me/billing')}>查看个人订阅</Button>
              <Button type="primary" onClick={() => navigate('/checkout?plan=TEAM&period=monthly')}>
                升级团队版 ¥99/席/月
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={css.wrap}>
      <section className={css.panel}>
        <div className={`${css.panelBody} ${css.pbCurrent}`}>
          <div className={`${css.pbBadge} ${isEnterprise ? css.pbBadgePaid : ''}`}>
            {isEnterprise ? <SafetyOutlined /> : <TeamOutlined />}
          </div>
          <div className={css.pbInfo}>
            <div className={css.pbPlanName}>
              {isEnterprise ? '企业版 ENTERPRISE' : '团队版 TEAM'}
              <span className={`${css.tag} ${css.tagGreen}`} style={{ verticalAlign: 4, marginLeft: 8 }}>使用中</span>
            </div>
            <div className={css.pbPlanSub}>
              {isEnterprise
                ? '定制套餐 · 不限席位 · SSO / 私有化 / 定制规则'
                : `月付套餐 · ¥99/席/月 · ${entitlement?.planExpiresAt ? `有效期至 ${fmtDate(entitlement.planExpiresAt)}` : ''}`}
            </div>
            <div className={css.pbUsage}>
              <div className={css.pbUsageRow}>
                <span>席位用量</span>
                <b style={{ color: 'var(--color-text)' }}>
                  {usedSeats} / {seats === null || seats === undefined ? '不限' : seats} 席
                </b>
              </div>
              {seats && (
                <div className={css.progress}>
                  <i style={{ width: `${Math.min(100, Math.round((usedSeats / seats) * 100))}%` }} />
                </div>
              )}
              <div className={css.pbUsageRow} style={{ marginTop: 12 }}>
                <span>权益</span>
                <span>Playbook 红线 · 团队审批 · 不限台账 · 飞书通知</span>
              </div>
            </div>
          </div>
          <div className={css.pbSide}>
            <div className={css.pbCoupon}>
              <TeamOutlined style={{ color: 'var(--color-primary)' }} />
              <span>本月审查</span>
              <b style={{ marginLeft: 'auto' }}>{entitlement?.usedReviews ?? 0} 份 · 不限</b>
            </div>
            {!isEnterprise && (
              <Button block onClick={() => openLead('SEATS')}>增购席位</Button>
            )}
            <Button type="primary" block onClick={() => openLead('ENTERPRISE')}>
              联系开通企业版
            </Button>
          </div>
        </div>
      </section>

      <div className={css.grid2}>
        <div className={css.panel}>
          <div className={css.panelHead}><h3>套餐权益</h3></div>
          <div className={css.panelBody}>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {TEAM_FEATS.map((f) => (
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
          <div className={css.panelHead}><h3>订单记录</h3></div>
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
      </div>

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
