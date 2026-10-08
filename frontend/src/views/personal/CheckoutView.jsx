// frontend/src/views/personal/CheckoutView.jsx
// 模拟收银台（FR-13 / checkout 原型 #monthly/#yearly/#coupons/#success）：
// 左侧订单摘要（月付/年付/券包/团队升级），右侧微信/支付宝（模拟），一键支付立即生效。
// 文案以 docs/prototype/checkout.html 为唯一来源；价格以服务端订单返回为准。
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from 'antd'
import {
  CheckCircleFilled,
  LockFilled,
  MessageFilled,
  SafetyCertificateOutlined,
  WechatOutlined,
} from '@ant-design/icons'
import { useBillingStore } from '@/stores/billing.js'
import { useMeStore } from '@/stores/me.js'
import { useAuthStore } from '@/stores/auth.js'
import css from './personal.module.css'

// 商品展示元数据（三原型态文案逐字；团队升级为配置事实的功能性文案）
const ITEM_META = {
  PERSONAL_MONTHLY: {
    title: '个人版 · 月付',
    desc: '不限份数审查 · AI 语义审查与改稿 · Word 红划线 · 永久存档 · 个人条款库',
    goods: '个人版 · 月付',
    amount: '19.00',
    amountPrefix: '¥',
    per: '/ 月',
  },
  PERSONAL_YEARLY: {
    title: '个人版 · 年付',
    titleTag: '年付省 ¥129',
    desc: '权益与月付一致，一次开通 12 个月；相当于 ¥8.25/月。',
    goods: '个人版 · 年付',
    amount: '99.00',
    amountPrefix: '¥',
    strike: '¥228',
    per: '/ 年',
    save: '较月付连续订阅节省 ¥129（省 48%）',
  },
  COUPON_PACK: {
    title: '深度审查券包 · 10 张',
    desc: '1 券解锁 1 份深度审查（含长文档、非标合同），含 AI 改稿与 Word 红划线导出。',
    goods: '深度审查券包 10 张',
    amount: '99.00',
    amountPrefix: '¥',
    per: '¥9.9 × 10 张',
  },
  TEAM_MONTHLY: {
    title: '团队版 · 月付',
    desc: '5 席位 · Playbook 公司红线规则 · 团队共享合同与审批 · 飞书通知',
    goods: '团队版 · 月付（5 席位）',
    amount: '99.00',
    amountPrefix: '¥',
    per: '/ 席/月',
  },
}

function resolveItem(sp) {
  // 参数严格白名单校验：任何不认识的 item/plan/period 一律返回 null（页面渲染错误态），
  // 不得静默回退，避免 URL 与实际下单商品不一致
  const rawItem = sp.get('item')
  if (rawItem !== null) {
    return rawItem === 'COUPON_PACK' ? 'COUPON_PACK' : null
  }
  const rawPlan = sp.get('plan')
  const rawPeriod = sp.get('period')
  const plan = (rawPlan ?? 'PERSONAL').toUpperCase()
  const period = (rawPeriod ?? 'monthly').toLowerCase()
  if (!['PERSONAL', 'TEAM'].includes(plan)) return null
  if (!['monthly', 'yearly'].includes(period)) return null
  if (plan === 'TEAM') return period === 'monthly' ? 'TEAM_MONTHLY' : null
  return period === 'yearly' ? 'PERSONAL_YEARLY' : 'PERSONAL_MONTHLY'
}

export default function CheckoutView() {
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { loadEntitlement, entitlement } = useMeStore()
  const { createOrder, mockPay } = useBillingStore()

  const item = useMemo(() => resolveItem(sp), [sp])
  const meta = ITEM_META[item]
  const [channel, setChannel] = useState('WECHAT')
  const [paying, setPaying] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => { loadEntitlement() }, [loadEntitlement])

  const workspaceLabel = entitlement?.workspaceType === 'TEAM' ? '团队空间' : '个人空间'
  const accountName = user?.displayName || user?.username || '当前账号'

  const doPay = async () => {
    if (!item) return
    setPaying(true)
    try {
      const order = await createOrder(item)
      const paid = await mockPay(order.id, channel)
      setResult(paid)
      await loadEntitlement()
    } catch (e) {
      // 拦截器已 toast；补充确保按钮恢复
    } finally {
      setPaying(false)
    }
  }

  // ── 支付成功面板 ──
  if (result) {
    const successText = item === 'COUPON_PACK'
      ? '深度券已到账（10 张），每份合同可解锁 1 份深度审查。'
      : item === 'TEAM_MONTHLY'
        ? '团队版已开通，Playbook 公司红线、团队共享与飞书通知已生效。'
        : '个人版已开通 / 深度券已到账，现在可以不限份数审查合同并使用 AI 改稿。'
    const homePath = item === 'TEAM_MONTHLY' ? '/dashboard' : '/home'
    const billingPath = item === 'TEAM_MONTHLY' ? '/billing' : '/me/billing'
    return (
      <div className={css.coTopbarShell}>
        <TopBar />
        <main className={css.coWrap}>
          <div className={`${css.coCard} ${css.coSuccessCard}`}>
            <div className={css.coSuccess}>
              <div className={css.coSuccessIc}><CheckCircleFilled /></div>
              <h2>支付成功，权益已生效</h2>
              <p>{successText}</p>
              <p className={`${css.muted} ${css.small}`}>
                订单号 {result.order.orderNo} · 模拟支付 ¥{result.order.amountYuan}（以实际选择套餐为准）
              </p>
              <div className={css.coSuccessBtns}>
                <Button type="primary" size="large" onClick={() => navigate(homePath)}>进入工作台</Button>
                <Button size="large" onClick={() => navigate(billingPath)}>查看我的订阅</Button>
              </div>
            </div>
          </div>
        </main>
      </div>
    )
  }

  // ── 非法商品参数 ──
  if (!item) {
    return (
      <div className={css.coTopbarShell}>
        <TopBar />
        <main className={css.coWrap}>
          <div className={`${css.coCard} ${css.coSuccessCard}`}>
            <div className={css.coSuccess}>
              <div className={css.coSuccessIc}><SafetyCertificateOutlined /></div>
              <h2>商品不存在或已下架</h2>
              <p>链接中的商品参数无效，请从套餐页重新选择。</p>
              <div className={css.coSuccessBtns}>
                <Button type="primary" size="large" onClick={() => navigate('/pricing')}>查看套餐</Button>
                <Button size="large" onClick={() => navigate('/home')}>进入工作台</Button>
              </div>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className={css.coTopbarShell}>
      <TopBar />
      <main className={css.coWrap}>
        <div className={css.coCard}>
          <div className={css.coCardHead}>
            <h2>确认订单并支付</h2>
            <p>支付后权益立即生效，可在「我的订阅」中查看订单与套餐状态</p>
          </div>

          <div className={css.coGrid}>
            {/* 左：订单摘要 */}
            <div className={`${css.coCol} ${css.coSummary}`}>
              <div className={css.coSumName}>订单摘要</div>
              <div className={css.coSumTitle}>
                {meta.title}
                {meta.titleTag && <span className={`${css.tag} ${css.tagGreen}`}>{meta.titleTag}</span>}
              </div>
              <div className={css.coSumDesc}>{meta.desc}</div>
              <div className={css.coAmount}>
                <b>{meta.amountPrefix}{meta.amount}</b>
                {meta.strike && <small>{meta.strike}</small>}
                <span className={`${css.small} ${css.muted}`}>{meta.per}</span>
              </div>
              {meta.save && <div className={css.coSave}>{meta.save}</div>}

              <div className={css.coDivider} />
              <div className={css.coLine}><span>商品</span><b>{meta.goods}</b></div>
              <div className={css.coLine}><span>支付方式</span><b>{channel === 'WECHAT' ? '微信支付' : '支付宝'}</b></div>
              <div className={css.coLine}><span>账号</span><b>{accountName} · {workspaceLabel}</b></div>
              <div className={css.coLine}>
                <span>应付金额</span>
                <b className={css.coAmountDue}>¥{meta.amount}</b>
              </div>

              <div className={css.coDemonote}>
                <SafetyCertificateOutlined className={css.coNoteIcon} />
                <span>支付后权益立即生效。演示环境不产生真实扣款，订单数据为模拟数据。</span>
              </div>
            </div>

            {/* 右：支付方式 */}
            <div className={css.coCol}>
              <div className={css.coPayTitle}>选择支付方式</div>
              <div className={css.coPay}>
                <label className={`${css.coPayItem} ${channel === 'WECHAT' ? css.coPayActive : ''}`}>
                  <input
                    type="radio" name="pay" checked={channel === 'WECHAT'}
                    onChange={() => setChannel('WECHAT')}
                  />
                  <span className={css.coRadio} />
                  <span className={`${css.coChannelIc} ${css.coWechat}`}><WechatOutlined /></span>
                  <span>微信支付</span>
                  <span className={css.coChannelSub}>推荐</span>
                </label>
                <label className={`${css.coPayItem} ${channel === 'ALIPAY' ? css.coPayActive : ''}`}>
                  <input
                    type="radio" name="pay" checked={channel === 'ALIPAY'}
                    onChange={() => setChannel('ALIPAY')}
                  />
                  <span className={css.coRadio} />
                  <span className={`${css.coChannelIc} ${css.coAlipay}`}>
                    <MessageFilled />
                  </span>
                  <span>支付宝</span>
                  <span className={css.coChannelSub}>&nbsp;</span>
                </label>
              </div>

              <div className={css.coPayTitle} style={{ marginTop: 20 }}>账单明细</div>
              <div className={`${css.small} ${css.muted}`} style={{ lineHeight: 1.9 }}>
                · 虚拟服务，支付成功后立即开通，不支持 7 天无理由退订<br />
                · 连续套餐可随时取消，到期后降级为免费版<br />
                · 深度券长期有效，每份合同仅限解锁一次
              </div>
            </div>
          </div>

          <div className={css.coFoot}>
            <div className={css.coAgree}>
              点击「模拟支付，立即生效」即表示你已阅读并同意
              <Link to="/terms">《用户协议》</Link>与<Link to="/privacy">《隐私政策》</Link>，并知悉本页为原型演示环境。
            </div>
            <Button
              type="primary" size="large" block loading={paying}
              className={css.coPayBtn} onClick={doPay}
            >
              模拟支付，立即生效
            </Button>
          </div>
        </div>
      </main>
    </div>
  )
}

function TopBar() {
  return (
    <div className={css.coTopbar}>
      <Link className={css.coBrand} to="/home">
        <span className={css.logoMark}>
          <SafetyCertificateOutlined />
        </span>
        ClauseMind
      </Link>
      <span className={css.coEnv}>
        <LockFilled />
        模拟支付环境 · 不会产生真实扣款
      </span>
    </div>
  )
}
