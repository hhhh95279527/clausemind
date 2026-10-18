// frontend/src/views/team/RefundDrawer.jsx
// 退款抽屉（订单记录「申请退款」入口）：
//   第一步：表单（选择订单 + 原因枚举 + 补充说明 + 附件 ≤5 份 ×10MB）
//   第二步：会话（AI 客服接待 → 可转人工 → 人工处理），3s 轮询刷新消息与状态
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, Input, Select, Tag, Upload } from 'antd'
import { SendOutlined, UserSwitchOutlined, UploadOutlined } from '@ant-design/icons'
import { useAppStore } from '@/stores/app.js'
import { useBillingStore } from '@/stores/billing.js'
import { useRefundStore, REFUND_REASON_OPTIONS } from '@/stores/refund.js'
const STATUS_META = {
  CHAT: { color: 'processing', label: 'AI 客服接待中' },
  AGENT: { color: 'warning', label: '人工客服处理中' },
}

function fmtDateTime(s) {
  if (!s) return ''
  const d = new Date(s)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 12 },
  label: { fontSize: 13, fontWeight: 600 },
  chat: {
    flex: 1, minHeight: 260, overflowY: 'auto', padding: '4px 2px',
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  bubbleRow: { display: 'flex', gap: 8 },
  bubble: {
    maxWidth: '82%', padding: '8px 12px', borderRadius: 12, fontSize: 13.5,
    lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
  },
  sender: { fontSize: 11.5, opacity: 0.65, marginBottom: 2 },
  inputRow: { display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid var(--color-border)' },
}

export default function RefundDrawer({ open, onClose, initialOrder, initialRequestId }) {
  const toast = useAppStore((s) => s.toast)
  const { orders } = useBillingStore()
  const { create, detail, sendMessage, escalate, loadMine } = useRefundStore()

  const [stage, setStage] = useState('form') // form | chat
  const [orderId, setOrderId] = useState(undefined)
  const [reason, setReason] = useState(undefined)
  const [description, setDescription] = useState('')
  const [fileList, setFileList] = useState([])
  const [submitting, setSubmitting] = useState(false)
  // 真实订单（转账支付）必填：收款信息，超管线下回款用
  const [refundChannel, setRefundChannel] = useState('WECHAT')
  const [refundAccount, setRefundAccount] = useState('')
  const [refundAccountName, setRefundAccountName] = useState('')

  const [request, setRequest] = useState(null)
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const chatRef = useRef(null)

  // 可退款订单：已支付 且 未申请过退款（后端也会兜底 409）
  const refundableOrders = useMemo(() => {
    const requested = new Set(useRefundStore.getState().requests.map((r) => r.orderId))
    return orders.filter((o) => o.status === 'PAID' && !requested.has(o.id))
  }, [orders])

  useEffect(() => {
    if (!open) return
    setReason(undefined)
    setDescription('')
    setFileList([])
    setRequest(null)
    setMessages([])
    setDraft('')
    setRefundChannel('WECHAT')
    setRefundAccount('')
    setRefundAccountName('')
    if (initialRequestId) {
      // 已有工单：直接进入会话阶段
      detail(initialRequestId)
        .then((data) => { setRequest(data.request); setMessages(data.messages || []); setStage('chat') })
        .catch(() => setStage('form'))
    } else {
      setOrderId(initialOrder?.id || undefined)
      setStage('form')
    }
  }, [open, initialOrder, initialRequestId, detail])

  // 会话轮询：抽屉打开且工单未终态时每 3s 拉详情
  useEffect(() => {
    if (!open || stage !== 'chat' || !request) return undefined
    const id = request.id
    const timer = setInterval(async () => {
      try {
        const data = await detail(id)
        setRequest(data.request)
        setMessages(data.messages || [])
      } catch { /* 轮询失败静默，下个周期重试 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [open, stage, request?.id, detail])

  // 新消息滚动到底部
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [messages.length])

  // 所选订单是否真实转账单（transferNo 非空）→ 需要填收款信息
  const selectedOrder = useMemo(() => refundableOrders.find((o) => o.id === orderId), [refundableOrders, orderId])
  const isRealOrder = !!selectedOrder?.transferNo

  const submit = async () => {
    if (!orderId) { toast.warning('请选择要退款的订单'); return }
    if (!reason) { toast.warning('请选择退款原因'); return }
    if (isRealOrder) {
      if (!refundAccount.trim()) { toast.warning('请填写退款收款账号'); return }
      if (!refundAccountName.trim()) { toast.warning('请填写收款人姓名'); return }
    }
    setSubmitting(true)
    try {
      const files = fileList.map((f) => f.originFileObj).filter(Boolean)
      const data = await create({
        orderId, reason, description: description.trim(),
        ...(isRealOrder ? { refundChannel, refundAccount: refundAccount.trim(), refundAccountName: refundAccountName.trim() } : {}),
      }, files)
      setRequest(data.request)
      setMessages(data.messages || [])
      setStage('chat')
      loadMine().catch(() => {})
    } finally {
      setSubmitting(false)
    }
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || !request || sending) return
    setSending(true)
    try {
      const data = await sendMessage(request.id, content)
      setRequest(data.request)
      setMessages(data.messages || [])
      setDraft('')
    } catch {
      // 错误已由 http 层提示；刷新本地状态对齐服务端
      detail(request.id).then((d) => { setRequest(d.request); setMessages(d.messages || []) }).catch(() => {})
    } finally {
      setSending(false)
    }
  }

  const doEscalate = async () => {
    if (!request) return
    try {
      const data = await escalate(request.id)
      setRequest(data.request)
      setMessages(data.messages || [])
      toast.success('已转接人工客服')
    } catch { /* http 层已提示 */ }
  }

  const statusMeta = request ? STATUS_META[request.status] : null

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title={stage === 'form' ? '申请退款' : '退款处理进度'}
      destroyOnClose
    >
      {stage === 'form' ? (
        <div style={styles.section}>
          <div>
            <div style={styles.label}>退款订单</div>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              placeholder="选择已支付的订单"
              value={orderId}
              onChange={setOrderId}
              options={refundableOrders.map((o) => ({
                value: o.id,
                label: `${ORDER_GOODS[o.item] || o.item} · ¥${o.amountYuan} · ${fmtDateTime(o.paidAt || o.createdAt)}`,
              }))}
              notFoundContent="暂无可退款的已支付订单"
            />
          </div>
          <div>
            <div style={styles.label}>退款原因</div>
            <Select
              style={{ width: '100%', marginTop: 6 }}
              placeholder="请选择原因"
              value={reason}
              onChange={setReason}
              options={REFUND_REASON_OPTIONS}
            />
          </div>
          <div>
            <div style={styles.label}>补充说明</div>
            <Input.TextArea
              style={{ marginTop: 6 }}
              rows={4}
              maxLength={1000}
              showCount
              placeholder="描述遇到的问题，方便客服更快处理（可留空）"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {/* 真实转账订单：必填收款信息，超管据此线下回款 */}
          {isRealOrder && (
            <div style={{
              border: '1px dashed var(--color-border, #d9d9d9)', borderRadius: 10,
              padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-sub)' }}>
                退款收款信息（真实转账订单必填，客服将按此转账退款）
              </div>
              <div>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>收款渠道</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['WECHAT', 'ALIPAY', 'BANK'].map((c) => (
                    <Button
                      key={c} size="small"
                      type={refundChannel === c ? 'primary' : 'default'}
                      onClick={() => setRefundChannel(c)}
                    >
                      {c === 'WECHAT' ? '微信' : c === 'ALIPAY' ? '支付宝' : '银行'}
                    </Button>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>收款账号</div>
                <Input
                  placeholder={refundChannel === 'WECHAT' ? '微信号' : refundChannel === 'ALIPAY' ? '手机号' : '银行卡号'}
                  value={refundAccount}
                  maxLength={100}
                  onChange={(e) => setRefundAccount(e.target.value)}
                />
              </div>
              <div>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>收款人姓名</div>
                <Input
                  placeholder="与收款账号对应的实名"
                  value={refundAccountName}
                  maxLength={50}
                  onChange={(e) => setRefundAccountName(e.target.value)}
                />
              </div>
            </div>
          )}
          <div>
            <div style={styles.label}>凭证附件</div>
            <Upload
              style={{ marginTop: 6 }}
              multiple
              maxCount={5}
              fileList={fileList}
              accept=".jpg,.jpeg,.png,.webp,.pdf,.docx,.txt,.md"
              beforeUpload={(file) => {
                if (file.size > 10 * 1024 * 1024) {
                  toast.error('单个附件不能超过 10MB')
                  return Upload.LIST_IGNORE
                }
                return false
              }}
              onChange={({ fileList: fl }) => setFileList(fl.slice(-5))}
            >
              <Button icon={<UploadOutlined />}>上传附件（≤5 份，单份 ≤10MB）</Button>
            </Upload>
          </div>
          <Button type="primary" block loading={submitting} onClick={submit}>
            提交申请
          </Button>
          <div style={{ fontSize: 12.5, color: 'var(--color-text-3)', lineHeight: 1.7 }}>
            提交后由 AI 客服先接待，可随时转人工；退款结果由平台客服确认后生效。
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%' }}>
          {/* 工单摘要 + 状态 */}
          <div style={{
            border: '1px solid var(--color-border)', borderRadius: 10, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b>{request?.itemLabel}</b>
              <span style={{ fontWeight: 600 }}>¥{request?.amountYuan}</span>
              {statusMeta && <Tag color={statusMeta.color} style={{ marginLeft: 'auto', marginInlineEnd: 0 }}>{statusMeta.label}</Tag>}
              {request?.status === 'RESOLVED' && (
                request.resolution === 'APPROVED'
                  ? <Tag color="success" style={{ marginLeft: 'auto', marginInlineEnd: 0 }}>退款已同意</Tag>
                  : <Tag color="default" style={{ marginLeft: 'auto', marginInlineEnd: 0 }}>未通过审核</Tag>
              )}
            </div>
            <div style={{ color: 'var(--color-text-3)', fontSize: 12.5 }}>
              原因：{request?.reasonLabel}{request?.description ? ` · ${request.description}` : ''}
              {request?.attachments?.length > 0 && ` · 附件 ${request.attachments.length} 份`}
            </div>
          </div>

          {/* 会话区 */}
          <div style={styles.chat} ref={chatRef}>
            {messages.map((m) => {
              if (m.sender === 'SYSTEM') {
                return (
                  <div key={m.id} style={{ textAlign: 'center', fontSize: 12, color: 'var(--color-text-3)' }}>
                    {m.content}
                  </div>
                )
              }
              const mine = m.sender === 'USER'
              const senderLabel = mine ? '我' : m.sender === 'AI' ? '智能客服' : '人工客服'
              return (
                <div key={m.id} style={{ ...styles.bubbleRow, justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                  {!mine && <div style={{ ...styles.bubble, background: 'var(--color-fill-1, #f5f5f5)' }}>
                    <div style={styles.sender}>{senderLabel} · {fmtDateTime(m.createdAt)}</div>
                    {m.content}
                  </div>}
                  {mine && <div style={{ ...styles.bubble, background: 'color-mix(in srgb, var(--color-primary) 12%, transparent)' }}>
                    <div style={styles.sender}>{senderLabel} · {fmtDateTime(m.createdAt)}</div>
                    {m.content}
                  </div>}
                </div>
              )
            })}
          </div>

          {/* 输入区 / 终态提示 */}
          {request?.status === 'RESOLVED' ? (
            <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--color-text-3)', padding: 8 }}>
              工单已处理完毕
            </div>
          ) : (
            <>
              <div style={styles.inputRow}>
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPressEnter={send}
                  placeholder={request?.status === 'AGENT' ? '人工客服处理中，可补充说明…' : '输入消息，与客服沟通…'}
                  maxLength={1000}
                  disabled={sending}
                />
                <Button type="primary" icon={<SendOutlined />} loading={sending} onClick={send} />
              </div>
              {request?.status === 'CHAT' && (
                <Button block icon={<UserSwitchOutlined />} onClick={doEscalate}>
                  转人工客服
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  )
}

const ORDER_GOODS = {
  PERSONAL_MONTHLY: '个人版月付',
  PERSONAL_YEARLY: '个人版年付',
  COUPON_PACK: '深度审查券包 × 10',
  TEAM_MONTHLY: '团队版月付（5 席位）',
}
