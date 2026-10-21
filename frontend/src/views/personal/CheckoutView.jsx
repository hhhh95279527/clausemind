// frontend/src/views/personal/CheckoutView.jsx
// 模拟收银台（FR-13 / checkout 原型 #monthly/#yearly/#coupons/#success）：
// 左侧订单摘要（月付/年付/券包/团队升级），右侧微信/支付宝（模拟），一键支付立即生效。
// 文案以 docs/prototype/checkout.html 为唯一来源；价格以服务端订单返回为准。
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button, Input, Upload } from 'antd'
import {
  CheckCircleFilled,
  LockFilled,
  SafetyCertificateOutlined,
  WechatOutlined,
  UploadOutlined,
} from '@ant-design/icons'
import { useBillingStore } from '@/stores/billing.js'
import { useMeStore } from '@/stores/me.js'
import { useAuthStore } from '@/stores/auth.js'
import { useAppStore } from '@/stores/app.js'
import { trackCheckoutSuccess } from '@/utils/analytics.js'
import http from '@/utils/http.js'
import css from './personal.module.css'

// 商品展示元数据（三原型态文案逐字；团队升级为配置事实的功能性文案）
const ITEM_META = {
  PERSONAL_MONTHLY: {
    title: '个人版 · 月付',
    desc: '不限份数审查 · AI 语义审查与改稿 · Word 红划线 · 永久存档 · 个人条款库',
    goods: '个人版 · 月付',
    amount: '0.01',
    amountPrefix: '¥',
    per: '/ 月',
  },
  PERSONAL_YEARLY: {
    title: '个人版 · 年付',
    titleTag: '年付测试价 ¥0.01',
    desc: '权益与月付一致，一次开通 12 个月。',
    goods: '个人版 · 年付',
    amount: '0.01',
    amountPrefix: '¥',
    strike: undefined,
    per: '/ 年',
    save: '测试期统一定价 ¥0.01（所有套餐）',
  },
  COUPON_PACK: {
    title: '深度审查券包 · 10 张',
    desc: '1 券解锁 1 份深度审查（含长文档、非标合同），含 AI 改稿与 Word 红划线导出。',
    goods: '深度审查券包 10 张',
    amount: '0.01',
    amountPrefix: '¥',
    per: '共 10 张',
  },
  TEAM_MONTHLY: {
    title: '团队版 · 月付',
    desc: '5 席位 · Playbook 公司红线规则 · 团队共享合同与审批 · 飞书通知',
    goods: '团队版 · 月付（5 席位）',
    amount: '0.01',
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
  const setUser = useAuthStore((s) => s.setUser)
  const { loadEntitlement, entitlement } = useMeStore()
  const { createOrder, mockPay } = useBillingStore()
  const paymentEnabled = useAppStore((s) => s.paymentEnabled)

  const item = useMemo(() => resolveItem(sp), [sp])
  const meta = ITEM_META[item]
  // 非白名单账号只有「转账支付」一种方式，默认选中 TRANSFER
  const [channel, setChannel] = useState(null)
  const [paying, setPaying] = useState(false)
  const [result, setResult] = useState(null)
  // 转账支付（人工确认模式）：管理员收款码 + 用户提交转账单号 → 超管确认开通
  const [payInfo, setPayInfo] = useState(null)
  const [transferNo, setTransferNo] = useState('')
  const [transferSubmitting, setTransferSubmitting] = useState(false)
  const [transferDone, setTransferDone] = useState(false)
  // 转账凭证截图（≤3 张，图片/PDF）
  const [proofFiles, setProofFiles] = useState([])
  // 当前账号支付模式：白名单可模拟支付，其余仅真实转账
  const [payOptions, setPayOptions] = useState(null)

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => {
    http.get('/billing/payment-info').then(setPayInfo).catch(() => {})
    http.get('/billing/pay-options').then((opts) => {
      setPayOptions(opts)
      // 默认渠道：白名单→微信模拟支付；非白名单→微信支付（真实扫码）
      setChannel('WECHAT')
    }).catch(() => {
      setPayOptions({ simulatePay: false })
      setChannel('WECHAT')
    })
  }, [])

  const workspaceLabel = entitlement?.workspaceType === 'TEAM' ? '团队空间' : '个人空间'
  const accountName = user?.displayName || user?.username || '当前账号'
  const homePath = '/dashboard'
  const billingPath = '/billing'

  const doPay = async () => {
    if (!item) return
    setPaying(true)
    try {
      const order = await createOrder(item)
      const paid = await mockPay(order.id, channel)
      setResult(paid)
      trackCheckoutSuccess(item)
      await loadEntitlement()
      // 团队版支付会把租户升级为团队空间：同步刷新登录态里的用户资料（含 workspaceType），
      // 否则 persona 仍按登录时的个人空间渲染，布局/导航不会切换为团队版
      try {
        const profile = await http.get('/auth/profile')
        if (profile?.id) setUser(profile)
      } catch {
        // 静默：下次进入应用会自愈刷新
      }
    } catch (e) {
      // 拦截器已 toast；补充确保按钮恢复
    } finally {
      setPaying(false)
    }
  }

  // 转账支付：提交转账单号 + 凭证截图，等待管理员人工确认到账后自动开通
  const submitTransfer = async () => {
    if (!item) return
    if (!transferNo.trim()) {
      useAppStore.getState().toast.warning('请填写转账单号（微信/支付宝账单中的转账记录单号）')
      return
    }
    setTransferSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('item', item)
      fd.append('channel', 'WECHAT')
      fd.append('transferNo', transferNo.trim())
      proofFiles.map((f) => f.originFileObj).filter(Boolean).forEach((f) => fd.append('proof', f))
      await http.post('/billing/transfer-orders', fd, { timeout: 60000 })
      setTransferDone(true)
    } catch {
      // 拦截器已 toast（重复单号 / 校验失败）
    } finally {
      setTransferSubmitting(false)
    }
  }

  // ── 购买入口关闭（如 ICP 备案审核期）：不展示任何价格与支付方式 ──
  if (!paymentEnabled) {
    return (
      <ResultScreen simulatePay={false}>
        <div className={css.coSuccessIc}><SafetyCertificateOutlined /></div>
        <h2>内测阶段，暂未开放购买</h2>
        <p>产品正在完善中，当前可免费使用基础审查能力，付费方案开放后会另行通知。</p>
        <div className={css.coSuccessBtns}>
          <Button type="primary" size="large" onClick={() => navigate(homePath)}>返回工作台</Button>
        </div>
      </ResultScreen>
    )
  }

  // ── 转账单已提交（等待人工确认）面板 ──
  if (transferDone) {
    return (
      <ResultScreen simulatePay={payOptions?.simulatePay}>
        <div className={css.coSuccessIc}><CheckCircleFilled /></div>
        <h2>转账信息已提交</h2>
        <p>管理员确认到账后，权益将自动开通，无需重复提交。</p>
        <p className={`${css.muted} ${css.small}`}>
          商品 {meta?.goods} · 应付 ¥{meta?.amount} · 转账单号 {transferNo}
        </p>
        <div className={css.coSuccessBtns}>
          <Button type="primary" size="large" onClick={() => navigate(billingPath)}>
            查看我的订阅
          </Button>
          <Button size="large" onClick={() => navigate(homePath)}>
            返回工作台
          </Button>
        </div>
      </ResultScreen>
    )
  }

  // ── 支付成功面板 ──
  if (result) {
    const successText = item === 'COUPON_PACK'
      ? '深度券已到账（10 张），每份合同可解锁 1 份深度审查。'
      : item === 'TEAM_MONTHLY'
        ? '团队版已开通，Playbook 公司红线、团队共享与飞书通知已生效。'
        : '个人版已开通 / 深度券已到账，现在可以不限份数审查合同并使用 AI 改稿。'
    return (
      <ResultScreen simulatePay={payOptions?.simulatePay}>
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
      </ResultScreen>
    )
  }

  // ── 非法商品参数 ──
  if (!item) {
    return (
      <ResultScreen simulatePay={payOptions?.simulatePay}>
        <div className={css.coSuccessIc}><SafetyCertificateOutlined /></div>
        <h2>商品不存在或已下架</h2>
        <p>链接中的商品参数无效，请从套餐页重新选择。</p>
        <div className={css.coSuccessBtns}>
          <Button type="primary" size="large" onClick={() => navigate('/pricing')}>查看套餐</Button>
          <Button size="large" onClick={() => navigate('/dashboard')}>进入工作台</Button>
        </div>
      </ResultScreen>
    )
  }

  return (
    <div className={css.coTopbarShell}>
      <TopBar simulatePay={payOptions?.simulatePay} />
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
              <div className={css.coLine}><span>支付方式</span><b>{channel === 'WECHAT' ? '微信支付' : channel === 'ALIPAY' ? '支付宝' : '转账支付（人工确认）'}</b></div>
              <div className={css.coLine}><span>账号</span><b>{accountName} · {workspaceLabel}</b></div>
              <div className={css.coLine}>
                <span>应付金额</span>
                <b className={css.coAmountDue}>¥{meta.amount}</b>
              </div>

              <div className={css.coDemonote}>
                <SafetyCertificateOutlined className={css.coNoteIcon} />
                <span>
                  {payOptions?.simulatePay
                    ? '支付后权益立即生效。演示环境不产生真实扣款，订单数据为模拟数据。'
                    : '转账支付为真实交易：管理员核对到账后立即开通权益，到账前不产生任何权益变更。'}
                </span>
              </div>
            </div>

            {/* 右：支付方式 */}
            <div className={css.coCol}>
              <div className={css.coPayTitle}>选择支付方式</div>
              <div className={css.coPay}>
                {/* 白名单：微信模拟支付（一键过）；非白名单：微信真实扫码支付（二维码+单号+截图） */}
                <label className={`${css.coPayItem} ${channel === 'WECHAT' ? css.coPayActive : ''}`}>
                  <input
                    type="radio" name="pay" checked={channel === 'WECHAT'}
                    onChange={() => setChannel('WECHAT')}
                  />
                  <span className={css.coRadio} />
                  <span className={`${css.coChannelIc} ${css.coWechat}`}><WechatOutlined /></span>
                  <span>微信支付</span>
                  <span className={css.coChannelSub}>
                    {payOptions?.simulatePay ? '推荐' : '扫码支付'}
                  </span>
                </label>
              </div>

              {/* 非白名单：微信支付真实扫码流程（二维码 + 单号 + 截图） */}
              {channel === 'WECHAT' && !payOptions?.simulatePay && (
                <div style={{ marginTop: 16, padding: 14, border: '1px dashed var(--color-border, #d9d9d9)', borderRadius: 10 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 8 }}>微信扫码支付</div>
                  {payInfo?.qrcodeUrl ? (
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
                      <img
                        src={payInfo.qrcodeUrl}
                        alt="微信收款码"
                        style={{ width: 200, height: 200, flexShrink: 0, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--color-border, #eee)', cursor: 'zoom-in' }}
                        onClick={() => window.open(payInfo.qrcodeUrl, '_blank')}
                      />
                      <div style={{ fontSize: 12.5, color: 'var(--color-text-sub)', lineHeight: 1.7 }}>
                        请用微信扫码支付 <b>¥{meta.amount}</b>，<br />支付成功后保留转账记录单号。
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12.5, color: 'var(--color-text-sub)', marginBottom: 12, lineHeight: 1.7 }}>
                      收款码加载中，请稍后刷新重试。
                    </div>
                  )}
                  <Input
                    placeholder="粘贴微信转账单号（账单中的转账记录单号）"
                    value={transferNo}
                    maxLength={100}
                    onChange={(e) => setTransferNo(e.target.value)}
                  />
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>支付凭证截图（可选，≤3 张）</div>
                    <Upload
                      multiple
                      maxCount={3}
                      fileList={proofFiles}
                      accept=".jpg,.jpeg,.png,.webp,.pdf"
                      beforeUpload={(file) => {
                        if (file.size > 10 * 1024 * 1024) {
                          useAppStore.getState().toast.error('单张凭证不能超过 10MB')
                          return Upload.LIST_IGNORE
                        }
                        return false
                      }}
                      onChange={({ fileList: fl }) => setProofFiles(fl.slice(-3))}
                    >
                      <Button size="small" icon={<UploadOutlined />}>上传截图</Button>
                    </Upload>
                  </div>
                </div>
              )}

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
              {payOptions?.simulatePay
                ? <>点击「模拟支付，立即生效」即表示你已阅读并同意<Link to="/terms">《用户协议》</Link>与<Link to="/privacy">《隐私政策》</Link>，并知悉本页为原型演示环境。</>
                : '提交微信支付单号即表示你已完成微信支付并同意管理员核对到账后开通权益，核对结果以管理员确认为准。'}
            </div>
            {channel === null ? (
              <Button type="primary" size="large" block loading className={css.coPayBtn}>
                加载支付选项中…
              </Button>
            ) : payOptions?.simulatePay ? (
              <Button
                type="primary" size="large" block loading={paying}
                className={css.coPayBtn} onClick={doPay}
              >
                模拟支付，立即生效
              </Button>
            ) : (
              <Button
                type="primary" size="large" block loading={transferSubmitting}
                className={css.coPayBtn} onClick={submitTransfer}
              >
                我已微信支付，提交单号
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  )
}

function TopBar({ simulatePay }) {
  return (
    <div className={css.coTopbar}>
      <Link className={css.coBrand} to="/dashboard">
        <span className={css.logoMark}>
          <SafetyCertificateOutlined />
        </span>
        ClauseMind
      </Link>
      <span className={css.coEnv}>
        <LockFilled />
        {simulatePay
          ? '模拟支付环境 · 不会产生真实扣款'
          : '真实转账环境 · 人工确认到账'}
      </span>
    </div>
  )
}

// 全屏结果页外壳（转账已提交 / 支付成功 / 商品无效三态共用）
function ResultScreen({ simulatePay, children }) {
  return (
    <div className={css.coTopbarShell}>
      <TopBar simulatePay={simulatePay} />
      <main className={css.coWrap}>
        <div className={`${css.coCard} ${css.coSuccessCard}`}>
          <div className={css.coSuccess}>{children}</div>
        </div>
      </main>
    </div>
  )
}
