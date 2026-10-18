// frontend/src/views/platform/PlatformRefundsTab.jsx
// 平台超管「退款工单」页签：列表（状态过滤）→ 工单详情抽屉（订单摘要 + 会话 + 附件下载）
//   处理动作：回复（人工客服身份，CHAT 自动切入 AGENT）/ 同意退款（订单标 REFUNDED + 权益降级）/ 拒绝（需填原因）
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, Card, Drawer, Empty, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import platformApi, { platformErrMessage } from '@/utils/platformApi.js'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'CHAT', label: 'AI 接待中' },
  { value: 'AGENT', label: '人工处理中' },
  { value: 'RESOLVED', label: '已处理' },
]
const STATUS_META = {
  CHAT: { color: 'processing', label: 'AI 接待中' },
  AGENT: { color: 'warning', label: '人工处理中' },
}
const REASON_LABELS = {
  MISBUY: '误购',
  DUPLICATE: '重复扣款',
  NOT_AS_EXPECTED: '效果不符预期',
  OTHER: '其他',
}
const REFUND_CHANNEL_LABELS = { WECHAT: '微信转账', ALIPAY: '支付宝转账', BANK: '银行转账' }
const SENDER_META = {
  USER: { label: '用户', color: '#1677ff' },
  AI: { label: '智能客服', color: '#722ed1' },
  AGENT: { label: '人工客服（我）', color: '#fa8c16' },
  SYSTEM: { label: '系统', color: '#8c8c8c' },
}

function fmtDateTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function PlatformRefundsTab() {
  const [status, setStatus] = useState('')
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)

  // 详情抽屉
  const [detail, setDetail] = useState(null) // { request, messages, entitlement }
  const [detailLoading, setDetailLoading] = useState(false)
  const [reply, setReply] = useState('')
  const [replying, setReplying] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState('')
  // 真实转账订单：同意退款需填回款转账单号
  const [approveOpen, setApproveOpen] = useState(false)
  const [refundTransferNo, setRefundTransferNo] = useState('')
  const chatRef = useRef(null)

  const loadList = useCallback(async (st = status) => {
    setLoading(true)
    try {
      const data = await platformApi.get('/refunds', { params: st ? { status: st } : {} })
      setList(data.requests || [])
    } catch (err) { /* 全局 401 已处理 */ } finally { setLoading(false) }
  }, [status])

  useEffect(() => { loadList() }, [loadList])

  const openDetail = async (id) => {
    setDetailLoading(true)
    setReply('')
    try {
      const data = await platformApi.get(`/refunds/${id}`)
      setDetail(data)
    } catch (err) { Modal.error({ title: '加载工单失败', content: platformErrMessage(err) }) } finally { setDetailLoading(false) }
  }

  // 会话轮询：抽屉打开且工单未终态时每 3s 刷新
  useEffect(() => {
    if (!detail || detail.request.status === 'RESOLVED') return undefined
    const id = detail.request.id
    const timer = setInterval(async () => {
      try {
        const data = await platformApi.get(`/refunds/${id}`)
        setDetail(data)
      } catch { /* 下个周期重试 */ }
    }, 3000)
    return () => clearInterval(timer)
  }, [detail?.request.id, detail?.request.status])

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight
  }, [detail?.messages?.length])

  const sendReply = async () => {
    const content = reply.trim()
    if (!content || !detail) return
    setReplying(true)
    try {
      const data = await platformApi.post(`/refunds/${detail.request.id}/messages`, { content })
      setDetail(data)
      setReply('')
      loadList()
    } catch (err) { Modal.error({ title: '回复失败', content: platformErrMessage(err) }) } finally { setReplying(false) }
  }

  const approve = async (transferNo) => {
    if (!detail) return
    setResolving(true)
    try {
      const payload = { decision: 'APPROVE' }
      if (transferNo) payload.refundTransferNo = transferNo
      const data = await platformApi.post(`/refunds/${detail.request.id}/resolve`, payload)
      setDetail(data)
      setApproveOpen(false)
      setRefundTransferNo('')
      Modal.success({
        title: '退款已同意',
        content: transferNo
          ? `¥${data.request.amountYuan} 已按用户提供的收款账户转账退回，回款单号：${transferNo}。订单已标记 REFUNDED，权益已同步降级。`
          : `¥${data.request.amountYuan} 已按原路退回（演示环境即时到账），订单已标记 REFUNDED，权益已同步降级。`,
      })
      loadList()
    } catch (err) { Modal.error({ title: '操作失败', content: platformErrMessage(err) }) } finally { setResolving(false) }
  }

  const submitReject = async () => {
    const reason = rejectReason.trim()
    if (!reason) return
    setResolving(true)
    try {
      const data = await platformApi.post(`/refunds/${detail.request.id}/resolve`, { decision: 'REJECT', note: reason })
      setDetail(data)
      setRejectOpen(false)
      setRejectReason('')
      loadList()
    } catch (err) { Modal.error({ title: '操作失败', content: platformErrMessage(err) }) } finally { setResolving(false) }
  }

  const downloadAttachment = async (index, name) => {
    try {
      const blob = await platformApi.get(`/refunds/${detail.request.id}/attachments/${index}`, { responseType: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name || `attachment-${index + 1}`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) { Modal.error({ title: '下载失败', content: platformErrMessage(err) }) }
  }

  const columns = [
    { title: '企业', dataIndex: 'tenantName', width: 150, render: (v, r) => (
      <Space size={4}><span style={{ fontWeight: 600 }}>{v}</span><Tag>{r.tenantPlan}</Tag></Space>
    ) },
    { title: '申请人', dataIndex: 'requester', width: 180, ellipsis: true },
    { title: '商品', dataIndex: 'itemLabel', width: 130 },
    { title: '金额', dataIndex: 'amountYuan', width: 80, align: 'right', render: (v) => <b>¥{v}</b> },
    { title: '原因', dataIndex: 'reasonLabel', width: 100 },
    { title: '说明/附件', width: 170, ellipsis: true, render: (_, r) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {r.description || '-'}{r.attachments?.length ? `（附件 ${r.attachments.length}）` : ''}
      </Typography.Text>
    ) },
    { title: '状态', dataIndex: 'status', width: 110, render: (s, r) => {
      if (s === 'CHAT') return <Tag color="processing">AI 接待中</Tag>
      if (s === 'AGENT') return <Tag color="warning">人工处理中</Tag>
      return r.resolution === 'APPROVED' ? <Tag color="success">已同意退款</Tag> : <Tag>已拒绝</Tag>
    } },
    { title: '申请时间', dataIndex: 'createdAt', width: 140, render: fmtDateTime },
    { title: '操作', key: 'ops', width: 90, fixed: 'right', render: (_, r) => (
      <Button size="small" type="link" onClick={() => openDetail(r.id)}>处理</Button>
    ) },
  ]

  const req = detail?.request
  const canResolve = req && req.status !== 'RESOLVED'
  // 真实转账订单：用户申请退款时填写了收款信息
  const isRealOrder = !!req?.refundAccount

  return (
    <Card size="small" title="退款工单处理" extra={
      <Space>
        <Select size="small" value={status} options={STATUS_OPTIONS} style={{ width: 120 }} onChange={(v) => setStatus(v)} />
        <Button size="small" icon={<ReloadOutlined />} onClick={() => loadList()}>刷新</Button>
      </Space>
    }>
      <Table columns={columns} dataSource={list} rowKey="id" loading={loading} scroll={{ x: 1100 }} size="middle"
        pagination={list.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
        locale={{ emptyText: <Empty description="暂无退款工单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} />

      <Drawer
        open={!!req}
        onClose={() => setDetail(null)}
        width={560}
        title={req ? `退款工单 · ${req.tenantName}` : ''}
        destroyOnClose
      >
        {req && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%' }}>
            {/* 订单摘要 */}
            <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, padding: '10px 12px', fontSize: 13, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
              <div><b>{req.itemLabel}</b> · ¥{req.amountYuan}</div>
              <div>订单状态：<Tag style={{ marginInlineEnd: 0 }}>{req.orderStatus === 'REFUNDED' ? '已退款' : req.orderStatus}</Tag></div>
              <div>申请人：{req.requester}</div>
              <div>申请时间：{fmtDateTime(req.createdAt)}</div>
              <div>原因：{REASON_LABELS[req.reason] || req.reason}</div>
              <div>支付时间：{fmtDateTime(req.orderPaidAt)}</div>
              {isRealOrder && (
                <div style={{ gridColumn: '1 / -1', background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 8, padding: '8px 10px', marginTop: 4 }}>
                  <div style={{ fontWeight: 600, color: '#d46b08', marginBottom: 2 }}>退款收款信息（真实转账订单）</div>
                  <div>收款渠道：{REFUND_CHANNEL_LABELS[req.refundChannel] || req.refundChannel || '-'}</div>
                  <div>收款账号：<Typography.Text copyable={{ text: req.refundAccount }}>{req.refundAccount}</Typography.Text></div>
                  <div>收款人：{req.refundAccountName}</div>
                  {req.refundTransferNo && (
                    <div>回款单号：<Typography.Text copyable={{ text: req.refundTransferNo }}>{req.refundTransferNo}</Typography.Text></div>
                  )}
                </div>
              )}
              {req.description && <div style={{ gridColumn: '1 / -1', color: '#666' }}>说明：{req.description}</div>}
              {req.attachments?.length > 0 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  附件：
                  {req.attachments.map((a) => (
                    <Button key={a.index} size="small" type="link" style={{ padding: 0, marginRight: 8 }}
                      onClick={() => downloadAttachment(a.index, a.name)}>
                      {a.name}（{fmtSize(a.size)}）
                    </Button>
                  ))}
                </div>
              )}
              {detail.entitlement && (
                <div style={{ gridColumn: '1 / -1', color: '#999', fontSize: 12 }}>
                  当前权益：{detail.entitlement.label} · 本月已审查 {detail.entitlement.usedReviews} 份 · 深度券 {detail.entitlement.couponBalance} 张
                  {detail.entitlement.planExpiresAt ? ` · 到期 ${fmtDateTime(detail.entitlement.planExpiresAt)}` : ''}
                </div>
              )}
            </div>

            {/* 会话 */}
            <div ref={chatRef} style={{ flex: 1, minHeight: 240, overflowY: 'auto', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(detail.messages || []).map((m) => {
                if (m.sender === 'SYSTEM') {
                  return (
                    <div key={m.id} style={{ textAlign: 'center', fontSize: 12, color: '#999' }}>
                      {m.content}
                    </div>
                  )
                }
                const meta = SENDER_META[m.sender]
                const mine = m.sender === 'AGENT'
                return (
                  <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                    <div style={{
                      maxWidth: '82%', padding: '8px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.65,
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      background: mine ? '#fff7e6' : '#f5f5f5',
                    }}>
                      <div style={{ fontSize: 11.5, opacity: 0.65, marginBottom: 2, color: meta?.color }}>
                        {meta?.label || m.sender} · {fmtDateTime(m.createdAt)}
                      </div>
                      {m.content}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 操作区 */}
            {canResolve ? (
              <>
                <div style={{ display: 'flex', gap: 8, paddingTop: 10, borderTop: '1px solid #f0f0f0' }}>
                  <Input
                    value={reply}
                    onChange={(e) => setReply(e.target.value)}
                    onPressEnter={sendReply}
                    placeholder={req.status === 'CHAT' ? '回复后将以人工客服身份接入…' : '以人工客服身份回复…'}
                    maxLength={1000}
                    disabled={replying}
                  />
                  <Button type="primary" loading={replying} onClick={sendReply}>回复</Button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {isRealOrder ? (
                    <Button type="primary" danger block loading={resolving}
                      onClick={() => { setRefundTransferNo(''); setApproveOpen(true) }}>
                      同意退款
                    </Button>
                  ) : (
                    <Popconfirm
                      title={`同意退款 ¥${req.amountYuan}？`}
                      description="订单将标记 REFUNDED，权益立即降级（订阅降 FREE / 券包扣券），不可撤销"
                      okText="同意退款" cancelText="取消" okButtonProps={{ danger: true }}
                      onConfirm={() => approve()}
                    >
                      <Button type="primary" danger block loading={resolving}>同意退款</Button>
                    </Popconfirm>
                  )}
                  <Button block onClick={() => { setRejectReason(''); setRejectOpen(true) }}>拒绝退款</Button>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', fontSize: 12.5, color: '#999', padding: 8 }}>
                工单已处理完毕（{req.resolution === 'APPROVED' ? '已同意退款' : '已拒绝'} · {fmtDateTime(req.resolvedAt)}）
              </div>
            )}
          </div>
        )}
      </Drawer>

      <Modal
        open={rejectOpen}
        title="拒绝退款"
        okText="确认拒绝" cancelText="取消"
        okButtonProps={{ danger: true, disabled: !rejectReason.trim() }}
        confirmLoading={resolving}
        onOk={submitReject}
        onCancel={() => setRejectOpen(false)}
      >
        <Input.TextArea
          rows={3}
          maxLength={500}
          showCount
          placeholder="请填写拒绝原因（将同步给用户）"
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
        />
      </Modal>

      {/* 真实转账订单：同意退款需回填回款转账单号作为资金凭证 */}
      <Modal
        open={approveOpen}
        title={`同意退款 ¥${req?.amountYuan ?? ''}（真实转账订单）`}
        okText="确认已转账退回" cancelText="取消"
        okButtonProps={{ danger: true, disabled: !refundTransferNo.trim() }}
        confirmLoading={resolving}
        onOk={() => approve(refundTransferNo.trim())}
        onCancel={() => setApproveOpen(false)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ background: '#fff7e6', border: '1px solid #ffd591', borderRadius: 8, padding: '10px 12px', fontSize: 13 }}>
            <div>收款渠道：{REFUND_CHANNEL_LABELS[req?.refundChannel] || req?.refundChannel || '-'}</div>
            <div>收款账号：<Typography.Text copyable={{ text: req?.refundAccount }}>{req?.refundAccount}</Typography.Text></div>
            <div>收款人：{req?.refundAccountName}</div>
          </div>
          <div>
            <div style={{ marginBottom: 6, fontSize: 13 }}>回款转账单号（必填，证明资金已退回用户）</div>
            <Input
              value={refundTransferNo}
              onChange={(e) => setRefundTransferNo(e.target.value)}
              maxLength={100}
              placeholder="微信 / 支付宝 / 银行转账记录单号"
            />
          </div>
          <div style={{ fontSize: 12, color: '#999' }}>
            确认后订单将标记 REFUNDED，权益立即降级（订阅降 FREE / 券包扣券），不可撤销。
          </div>
        </div>
      </Modal>
    </Card>
  )
}
