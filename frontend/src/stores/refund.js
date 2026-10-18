// frontend/src/stores/refund.js
// 退款工单：申请（订单+原因+附件）→ AI 客服对话 → 转人工 → 处理结果。
// 消息实时性走 3s 轮询（表结构预留 SSE 升级）。
import { create } from 'zustand'
import http from '@/utils/http.js'

export const REFUND_REASON_OPTIONS = [
  { value: 'MISBUY', label: '误购' },
  { value: 'DUPLICATE', label: '重复扣款' },
  { value: 'NOT_AS_EXPECTED', label: '效果不符预期' },
  { value: 'OTHER', label: '其他' },
]
export const REFUND_REASON_LABELS = Object.fromEntries(
  REFUND_REASON_OPTIONS.map((r) => [r.value, r.label]),
)

export const useRefundStore = create((set) => ({
  requests: [],

  /** 我的退款申请（新→旧），用于订单列表标记「已申请」 */
  loadMine: async () => {
    const data = await http.get('/refunds')
    const requests = data.requests || []
    set({ requests })
    return requests
  },

  /** 工单详情 + 会话消息 */
  detail: async (id) => {
    const data = await http.get(`/refunds/${id}`)
    return data
  },

  /** 创建退款申请：multipart（files ≤5 份 ×10MB），真实订单需带收款信息 */
  create: async ({ orderId, reason, description, refundChannel, refundAccount, refundAccountName }, files = []) => {
    const fd = new FormData()
    fd.append('orderId', orderId)
    fd.append('reason', reason)
    if (description) fd.append('description', description)
    if (refundChannel) fd.append('refundChannel', refundChannel)
    if (refundAccount) fd.append('refundAccount', refundAccount)
    if (refundAccountName) fd.append('refundAccountName', refundAccountName)
    files.forEach((f) => fd.append('files', f))
    const data = await http.post('/refunds', fd, { timeout: 60000 })
    return data
  },

  /** 发送会话消息（CHAT 状态触发 AI 回复，可自动升级人工） */
  sendMessage: async (id, content) => {
    const data = await http.post(`/refunds/${id}/messages`, { content })
    return data
  },

  /** 转人工 */
  escalate: async (id) => {
    const data = await http.post(`/refunds/${id}/escalate`)
    return data
  },
}))
