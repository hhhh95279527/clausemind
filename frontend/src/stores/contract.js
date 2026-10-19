// frontend/src/stores/contract.js
// 合同风险审查模块状态：合同列表/上传（文件或粘贴文本）/详情/发起审查(SSE)/人工终审/意见书
import { create } from 'zustand'
import http, { fetchStream } from '@/utils/http.js'
import { useAppStore } from './app.js'
import { trackFirstReviewStart, trackReviewCompleted, trackParseFailed, trackReportExported } from '@/utils/analytics.js'

// 合同状态 → antd Tag 颜色与中文
export const CONTRACT_STATUS_META = {
  UPLOADED:        { color: 'default',      text: '待解析' },
  PARSING:         { color: 'processing',   text: '解析中' },
  READY:           { color: 'blue',         text: '待审查' },
  REVIEWING:       { color: 'processing',   text: '审查中' },
  WAITING_REVIEW:  { color: 'orange',       text: '待人工终审' },
  COMPLETED:       { color: 'success',      text: '审查完成' },
  FAILED:          { color: 'error',        text: '解析失败' },
}

export const RISK_STATUS_META = {
  PENDING:  { text: '待确认' },
  ACCEPTED: { text: '已采纳' },
  IGNORED:  { text: '已忽略' },
  EDITED:   { text: '已修改' },
}

export const SEVERITY_COLOR = { HIGH: '#dc2626', MED: '#d97706', LOW: '#2563eb' }
export const SEVERITY_TEXT = { HIGH: '高风险', MED: '中风险', LOW: '低风险' }

// 合同类型下拉项（企业端上传弹窗 / 审查工作台改类型共用）；AUTO=让 AI 自动识别并匹配对应类型的红线规则
export const SCENE_OPTIONS = [
  { label: '自动识别（AI）', value: 'AUTO' },
  { label: '劳动合同', value: 'LABOR' },
  { label: '实习协议', value: 'INTERNSHIP' },
  { label: '劳务合同', value: 'SERVICE' },
  { label: '租赁合同', value: 'LEASE' },
  { label: '保密协议 NDA', value: 'NDA' },
  { label: '买卖合同', value: 'SALE' },
  { label: '借款合同', value: 'LOAN' },
  { label: '股权转让协议', value: 'EQUITY' },
  { label: '非标合同', value: 'CUSTOM' },
]

// 解析失败已上报的合同 ID：同一合同多次进入详情/轮询只计一次（质量指标不去重会虚增）
const parseFailReported = new Set()

export const useContractStore = create((set, get) => ({
  contracts: [],
  loadingList: false,
  sampleCopied: false,  // 本租户是否已领取新手引导示例合同（每租户限一次）
  detail: null,          // { contract, clauses, review }
  loadingDetail: false,

  // ── 合同列表（reviewStatus：PENDING/WAITING_REVIEW/APPROVED/FAILED）──
  loadContracts: async (reviewStatus = '') => {
    set({ loadingList: true })
    try {
      const qs = reviewStatus ? `?reviewStatus=${encodeURIComponent(reviewStatus)}` : ''
      const data = await http.get(`/contracts${qs}`)
      set({ contracts: data.contracts, sampleCopied: !!data.sampleCopied })
    } finally {
      set({ loadingList: false })
    }
  },

  // ── 新手引导：体验示例合同（每租户限一次、不扣额度；FR-3）──────
  copySample: async () => {
    const result = await http.post('/contracts/sample')
    useAppStore.getState().toast.success('示例合同已放入，正在解析条款…')
    await get().loadContracts()
    return result.contract
  },

  // ── 上传合同文件（XHR 监听进度；服务端异步入队解析）────────────
  uploadFile: async (file, title, scene = 'AUTO') => {
    const formData = new FormData()
    formData.append('file', file)
    if (title) formData.append('title', title)
    formData.append('scene', scene)

    const result = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/contracts/upload')
      xhr.setRequestHeader('Authorization', `Bearer ${useAuthToken()}`)
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText))
        else reject(new Error(JSON.parse(xhr.responseText)?.error?.message || '上传失败'))
      })
      xhr.addEventListener('error', () => reject(new Error('网络错误')))
      xhr.send(formData)
    })
    useAppStore.getState().toast.success(`「${result.contract.title}」已上传，正在解析条款…`)
    await get().loadContracts()
    return result.contract
  },

  // ── 粘贴文本建档 ────────────────────────────────────────────
  uploadText: async ({ title, content, scene = 'AUTO' }) => {
    const result = await http.post('/contracts/text', { title, content, scene })
    useAppStore.getState().toast.success('合同已创建，正在解析条款…')
    await get().loadContracts()
    return result.contract
  },

  // ── 发起审查前置预检（不扣券、不建任务）：PLAN_LIMIT 由页面捕获弹付费墙 ──
  checkEligibility: async ({ charCount, scene, payWithCoupon = false }) =>
    http.post('/contracts/eligibility', { charCount, scene, payWithCoupon }, { skipErrorToast: true }),

  // ── 合同助手窄域问答（FREE 仅 1 轮，锁定由后端返回 locked）────
  askContract: async (contractId, question) =>
    http.post(`/contracts/${contractId}/ask`, { question }),

  // ── 修改合同类型（scene='AUTO' 触发 AI 重新识别）；历史审查结果保留 ──
  updateContract: async (id, payload) => {
    const res = await http.patch(`/contracts/${id}`, payload)
    set((s) => ({
      contracts: s.contracts.map((c) => (c.id === id ? { ...c, ...res.contract } : c)),
    }))
    return res
  },

  deleteContract: async (id) => {
    await http.delete(`/contracts/${id}`)
    set((s) => ({ contracts: s.contracts.filter((c) => c.id !== id) }))
    useAppStore.getState().toast.success('合同已删除')
  },

  // ── 合同详情（条款 + 最近审查）──────────────────────────────
  loadDetail: async (id) => {
    set({ loadingDetail: true })
    try {
      const data = await http.get(`/contracts/${id}`)
      set({ detail: data })
      // 解析失败埋点（质量指标）：按合同去重，轮询期间不重复上报
      if (data.contract?.status === 'FAILED' && !parseFailReported.has(id)) {
        parseFailReported.add(id)
        trackParseFailed(
          (data.contract.fileName || '').split('.').pop()?.toLowerCase() || 'text',
          data.contract.parseError || '',
        )
      }
      return data
    } finally {
      set({ loadingDetail: false })
    }
  },
  // ── 发起审查（SSE：stage 进度 / risk 增量 / waiting 挂起）────
  reviewing: false,
  reviewStages: [],     // [{ stage, message }]
  liveRisks: [],        // Agent 轨实时增量风险（规则轨在结束后随详情返回）
  reviewStats: null,
  reviewError: '',

  resetReviewRun: () => set({ reviewStages: [], liveRisks: [], reviewStats: null, reviewError: '' }),

  startReview: async (contractId, { payWithCoupon = false } = {}) => {
    set({ reviewing: true, reviewStages: [], liveRisks: [], reviewStats: null, reviewError: '' })
    let taskId = null
    let blockedErr = null
    await fetchStream(`/api/contracts/${contractId}/reviews`, { payWithCoupon }, {
      // 心跳 15s；90s 完全无字节视为连接半开，静默断开后靠 loadDetail 自愈，不弹错误
      idleTimeoutMs: 90000,
      onEvent: (event, data) => {
        if (event === 'task') taskId = data.taskId
        if (event === 'stage') {
          set((s) => ({ reviewStages: [...s.reviewStages, { stage: data.stage, message: data.message }] }))
        }
        if (event === 'risk') {
          set((s) => ({ liveRisks: [...s.liveRisks, data] }))
        }
        if (event === 'waiting') set({ reviewStats: data.stats })
      },
      onError: (err) => {
        // PLAN_LIMIT（initSse 前真 403）交给页面弹付费墙，不在此 toast
        if (err.code === 'PLAN_LIMIT') {
          blockedErr = err
          set({ reviewError: err.message })
          return
        }
        set({ reviewError: err.message })
        useAppStore.getState().toast.error('审查失败：' + err.message)
      },
    })
    set({ reviewing: false })
    await get().loadDetail(contractId)
    // 真正发起成功才计漏斗（PLAN_LIMIT 被拦截不计）；聚合按用户去重，重复审查不增人数
    if (!blockedErr) {
      trackFirstReviewStart(get().detail?.contract?.scene)
      // 流程无错跑完才计「审查完成」：中间错误（批次失败/SSE 断连）不虚增成功率
      if (!get().reviewError) {
        trackReviewCompleted(get().detail?.contract?.scene)
      }
    }
    return { taskId, blocked: blockedErr }
  },

  // ── 提交终审决策（同步 JSON：服务端 resume LangGraph 后返回结果）─
  submitDecision: async (taskId, { finalDecision, actions }) =>
    http.post(`/reviews/${taskId}/decision`, { finalDecision, actions }),

  // ── 意见书 ─────────────────────────────────────────────────
  loadReport: async (taskId) => (await http.get(`/reviews/${taskId}/report`)).reportMd,

  // 意见书 Word 下载（FR-21：终审完成 + PERSONAL+；403/PLAN_LIMIT 由调用侧处理）
  downloadReportDocx: async (taskId, filename = '审查意见书.docx') => {
    await downloadBinary(`/api/reviews/${taskId}/report/docx`, filename)
    trackReportExported('report_docx', get().detail?.contract?.scene)
  },

  // 修订后新合同 Word（核心交付物）：mode=clean（默认）把已采纳的改写直接应用进原件、无痕迹可直接定稿；mode=redline 保留红划线修订痕迹
  exportRevisionDocx: async (contractId, mode = 'clean') => {
    const name = await downloadBinary(
      `/api/contracts/${contractId}/revisions/docx?mode=${mode}`,
      `修订后合同${mode === 'redline' ? '·红划线' : ''}.docx`,
    )
    trackReportExported('revision_docx', get().detail?.contract?.scene)
    return name
  },

  // ── 文档归档时间线（原始合同 / 审查意见书 / 修订稿链）──────────
  loadVersions: async (contractId) => http.get(`/contracts/${contractId}/versions`),

  // 下载归档版本（原件 / 意见书 / 修订稿）：下载已归档文件不消耗试用次数
  downloadVersion: async (contractId, versionId, fallbackName = '合同文档') =>
    downloadBinary(`/api/contracts/${contractId}/versions/${encodeURIComponent(versionId)}/download`, fallbackName),

  // 修订稿 PDF（variant：redline 红划线版 / clean 干净终版）
  exportRevisionPdf: async (contractId, variant = 'redline') => {
    const name = await downloadBinary(
      `/api/contracts/${contractId}/revisions/pdf?variant=${variant}`,
      `修订稿${variant === 'clean' ? '·干净终版' : ''}.pdf`,
    )
    trackReportExported('revision_pdf', get().detail?.contract?.scene)
    return name
  },

  // 意见书 PDF（与 Word 版同内容口径）
  exportReportPdf: async (taskId) => {
    const name = await downloadBinary(`/api/reviews/${taskId}/report/pdf`, '审查意见书.pdf')
    trackReportExported('report_pdf', get().detail?.contract?.scene)
    return name
  },
}))

// 组件外取 token（避免在 store 文件里直接耦合响应式 API）
import { useAuthStore } from './auth.js'
function useAuthToken() {
  return useAuthStore.getState().accessToken
}

// 二进制下载通用实现：优先采用响应头文件名（RFC5987 filename*，中文可读），回退到调用方给的兜底名
async function downloadBinary(url, fallbackName = 'download') {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${useAuthToken()}` } })
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}))
    throw Object.assign(new Error(data.error?.message || '导出失败'), {
      status: resp.status, code: data.error?.code, reason: data.error?.reason,
    })
  }
  const disposition = resp.headers.get('Content-Disposition') || ''
  const matched = /filename\*=UTF-8''([^;]+)/i.exec(disposition)
  const filename = matched ? decodeURIComponent(matched[1]) : fallbackName
  const blob = await resp.blob()
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
  return filename
}
