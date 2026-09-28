// frontend/src/stores/billing.js
// 模拟订单/券包/收银台（FR-13）。价格以服务端返回为准，前端只传商品 code。
import { create } from 'zustand'
import http from '@/utils/http.js'

export const useBillingStore = create((set) => ({
  orders: [],
  loadingOrders: false,

  loadOrders: async () => {
    set({ loadingOrders: true })
    try {
      const data = await http.get('/billing/orders')
      set({ orders: data.orders || [] })
      return data.orders || []
    } finally {
      set({ loadingOrders: false })
    }
  },

  /** 创建 PENDING 模拟订单 */
  createOrder: async (item) => {
    const data = await http.post('/billing/orders', { item })
    return data.order
  },

  /** 模拟支付立即生效，返回 { order, entitlement } */
  mockPay: async (orderId, channel = 'WECHAT') => {
    const data = await http.post(`/billing/orders/${orderId}/mock-pay`, { channel })
    return data
  },

  /** 取消订阅（二次确认后） */
  cancelSubscription: async () => {
    const data = await http.post('/billing/subscription/cancel', { confirm: true })
    return data
  },

  /** 企业版/席位增购留资 */
  submitEnterpriseLead: async (payload) => {
    const data = await http.post('/billing/enterprise-lead', payload)
    return data
  },
}))
