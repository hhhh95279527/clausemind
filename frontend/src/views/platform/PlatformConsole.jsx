// frontend/src/views/platform/PlatformConsole.jsx
// 平台超管控制台（Tab 分类）：
//   ① 运营总览（统计卡 + 租户管理 + 新建企业 + 成员管理）
//   ② 转账订单（用户转账 → 人工确认到账自动开通）
//   ③ 调用链路（跨租户 Trace 瀑布，排查缺陷）
//   ④ 埋点漏斗（个人版/企业版/全部分开查看）
// 独立鉴权：platform_token 失效自动跳回 /platform/login
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Table, Button, Tag, Space, Select, Modal, Form, Input, message,
  Popconfirm, Statistic, DatePicker, Typography, Tabs, Empty, Spin, Tooltip, Row, Col,
} from 'antd'
import dayjs from 'dayjs'
import {
  ReloadOutlined, PlusOutlined, LogoutOutlined, CheckCircleFilled, CloseCircleFilled,
} from '@ant-design/icons'
import platformApi, { PLATFORM_TOKEN_KEY, PLATFORM_USER_KEY, platformErrMessage } from '@/utils/platformApi.js'

const PLAN_OPTIONS = ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'].map((p) => ({ value: p, label: p }))
const ROLE_OPTIONS = [
  { value: 'ADMIN', label: 'ADMIN · 管理员' },
  { value: 'MANAGER', label: 'MANAGER · 审查负责人' },
  { value: 'USER', label: 'USER · 普通成员' },
  { value: 'READONLY', label: 'READONLY · 只读' },
]
const TRANSFER_STATUS_OPTIONS = [
  { value: 'PENDING', label: '待确认' },
  { value: 'PAID', label: '已确认到账' },
  { value: 'CANCELLED', label: '已驳回' },
]
const ITEM_LABELS = {
  PERSONAL_MONTHLY: '个人版 · 月付',
  PERSONAL_YEARLY: '个人版 · 年付',
  COUPON_PACK: '深度审查券包 ×10',
  TEAM_MONTHLY: '团队版 · 月付',
}
const CHANNEL_LABELS = { WECHAT: '微信', ALIPAY: '支付宝', BANK: '银行转账' }

// 调用链路
const FEATURE_OPTIONS = [
  { value: '', label: '全部功能' },
  { value: 'chat', label: '对话助手' },
  { value: 'knowledge', label: 'RAG 知识库' },
  { value: 'agent', label: '任务 Agent' },
  { value: 'contract_review', label: '合同审查' },
  { value: 'eval', label: '离线评测' },
]
const FEATURE_LABEL = Object.fromEntries(FEATURE_OPTIONS.map((f) => [f.value, f.label]))
const SPAN_META = {
  LLM: { color: '#4f46e5', label: 'LLM' },
  TOOL: { color: '#f59e0b', label: '工具' },
  RETRIEVER: { color: '#10b981', label: '检索' },
}

// 埋点漏斗
const FUNNEL_STEP_LABELS = {
  sign_up: '注册',
  first_review_start: '首次发起审查',
  first_result_seen: '看到审查结果',
  paywall_show: '付费墙曝光',
  paywall_click_upgrade: '点击升级',
  checkout_success: '支付成功',
}

const fmtTokens = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n))
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—')
const fmtDateTime = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function PlatformConsole() {
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('overview')

  // ── 运营总览 ──
  const [overview, setOverview] = useState(null)
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm] = Form.useForm()
  const [memberTenant, setMemberTenant] = useState(null)
  const [members, setMembers] = useState([])
  const [membersLoading, setMembersLoading] = useState(false)

  // ── 转账订单 ──
  const [transferOrders, setTransferOrders] = useState([])
  const [transferStatus, setTransferStatus] = useState('PENDING')
  const [transferLoading, setTransferLoading] = useState(false)
  const [rejectTarget, setRejectTarget] = useState(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectSubmitting, setRejectSubmitting] = useState(false)

  // ── 调用链路 ──
  const [traces, setTraces] = useState({ items: [], total: 0 })
  const [tracePage, setTracePage] = useState(1)
  const [traceFeature, setTraceFeature] = useState('')
  const [traceStatus, setTraceStatus] = useState('')
  const [tracePlan, setTracePlan] = useState('')
  const [traceLoading, setTraceLoading] = useState(false)
  const [selectedTraceId, setSelectedTraceId] = useState(null)
  const [traceDetail, setTraceDetail] = useState(null)
  const [traceDetailLoading, setTraceDetailLoading] = useState(false)
  const [expandedSpan, setExpandedSpan] = useState(null)

  // ── 埋点漏斗 ──
  const [funnelData, setFunnelData] = useState(null)
  const [funnelLoading, setFunnelLoading] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [ov, tl] = await Promise.all([platformApi.get('/overview'), platformApi.get('/tenants')])
      setOverview(ov)
      setTenants(tl.tenants || [])
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '数据加载失败'))
    } finally { setLoading(false) }
  }, [navigate])

  useEffect(() => { loadAll() }, [loadAll])

  const loadTransferOrders = useCallback(async (status) => {
    const st = status ?? transferStatus
    setTransferLoading(true)
    try {
      const data = await platformApi.get(`/transfer-orders?status=${st}`)
      setTransferOrders(data.orders || [])
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '转账订单加载失败'))
    } finally { setTransferLoading(false) }
  }, [navigate, transferStatus])

  useEffect(() => { loadTransferOrders() }, [loadTransferOrders])

  const loadTraces = useCallback(async () => {
    setTraceLoading(true)
    try {
      const params = new URLSearchParams({ page: tracePage, pageSize: 20 })
      if (traceFeature) params.set('feature', traceFeature)
      if (traceStatus) params.set('status', traceStatus)
      if (tracePlan) params.set('plan', tracePlan)
      const data = await platformApi.get(`/traces?${params.toString()}`)
      setTraces(data)
      if (data.items.length && (!selectedTraceId || !data.items.some((x) => x.id === selectedTraceId))) {
        setSelectedTraceId(data.items[0].id)
      }
      if (!data.items.length) setSelectedTraceId(null)
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '链路加载失败'))
    } finally { setTraceLoading(false) }
  }, [navigate, tracePage, traceFeature, traceStatus, tracePlan, selectedTraceId])

  useEffect(() => { if (activeTab === 'traces') loadTraces() }, [activeTab, loadTraces])

  useEffect(() => {
    if (!selectedTraceId) { setTraceDetail(null); return }
    let alive = true
    setTraceDetailLoading(true)
    setExpandedSpan(null)
    platformApi.get(`/traces/${selectedTraceId}`)
      .then((d) => { if (alive) setTraceDetail(d) })
      .catch((err) => { if (alive) message.error(platformErrMessage(err, '链路详情加载失败')) })
      .finally(() => { if (alive) setTraceDetailLoading(false) })
    return () => { alive = false }
  }, [selectedTraceId])

  const loadFunnel = useCallback(async () => {
    setFunnelLoading(true)
    try {
      const data = await platformApi.get('/analytics/funnel')
      setFunnelData(data)
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '漏斗加载失败'))
    } finally { setFunnelLoading(false) }
  }, [navigate])

  useEffect(() => { if (activeTab === 'funnel') loadFunnel() }, [activeTab, loadFunnel])

  const logout = () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY)
    localStorage.removeItem(PLATFORM_USER_KEY)
    navigate('/platform/login', { replace: true })
  }

  const handleRefresh = () => {
    loadAll()
    loadTransferOrders()
    if (activeTab === 'traces') loadTraces()
    if (activeTab === 'funnel') loadFunnel()
  }

  // ── 租户操作 ──
  const changePlan = async (t, plan) => {
    try {
      await platformApi.put(`/tenants/${t.id}/plan`, { plan })
      message.success(`${t.name} 已切换为 ${plan}`)
      loadAll()
    } catch (err) { message.error(platformErrMessage(err)) }
  }
  const changeExpiry = async (t, date) => {
    try {
      await platformApi.put(`/tenants/${t.id}/plan`, { planExpiresAt: date ? date.toISOString() : null })
      message.success(`${t.name} 订阅到期时间已更新`)
      loadAll()
    } catch (err) { message.error(platformErrMessage(err)) }
  }
  const toggleStatus = async (t) => {
    const next = t.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    try {
      await platformApi.put(`/tenants/${t.id}/status`, { status: next })
      message.success(next === 'DISABLED' ? `${t.name} 已停用` : `${t.name} 已启用`)
      loadAll()
    } catch (err) { message.error(platformErrMessage(err)) }
  }
  const doCreate = async () => {
    const v = await createForm.validateFields()
    setCreating(true)
    try {
      await platformApi.post('/tenants', v)
      message.success(`企业「${v.name}」已创建，管理员 ${v.adminUsername}`)
      setCreateOpen(false)
      createForm.resetFields()
      loadAll()
    } catch (err) { message.error(platformErrMessage(err)) } finally { setCreating(false) }
  }
  const openMembers = async (t) => {
    setMemberTenant(t)
    setMembersLoading(true)
    try {
      const data = await platformApi.get(`/tenants/${t.id}/users`)
      setMembers(data.users || [])
    } catch (err) { message.error(platformErrMessage(err)) } finally { setMembersLoading(false) }
  }
  const changeMemberRole = async (u, role) => {
    try { await platformApi.put(`/tenants/${memberTenant.id}/users/${u.id}`, { role }); message.success(`${u.username} 角色已改为 ${role}`); openMembers(memberTenant) }
    catch (err) { message.error(platformErrMessage(err)) }
  }
  const toggleMemberStatus = async (u) => {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    try { await platformApi.put(`/tenants/${memberTenant.id}/users/${u.id}`, { status: next }); message.success(`${u.username} 已${next === 'DISABLED' ? '禁用' : '启用'}`); openMembers(memberTenant) }
    catch (err) { message.error(platformErrMessage(err)) }
  }
  const resetPwd = async (u) => {
    try {
      const data = await platformApi.post(`/tenants/${memberTenant.id}/users/${u.id}/reset-password`)
      Modal.success({
        title: `已重置 ${u.username} 的密码`,
        content: (
          <div>
            <p>临时密码（仅显示一次）：</p>
            <Typography.Paragraph copyable style={{ fontSize: 16, fontWeight: 600, marginBottom: 0 }}>
              {data.temporaryPassword}
            </Typography.Paragraph>
          </div>
        ),
      })
      openMembers(memberTenant)
    } catch (err) { message.error(platformErrMessage(err)) }
  }

  // ── 转账订单操作 ──
  const confirmOrder = async (o) => {
    try {
      await platformApi.post(`/transfer-orders/${o.id}/confirm`)
      message.success(`${o.tenantName} 的「${ITEM_LABELS[o.item] || o.item}」已确认到账并开通`)
      loadTransferOrders()
      loadAll()
    } catch (err) { message.error(platformErrMessage(err)) }
  }
  const submitReject = async () => {
    if (!rejectTarget) return
    if (!rejectReason.trim()) { message.warning('请填写驳回原因'); return }
    setRejectSubmitting(true)
    try {
      await platformApi.post(`/transfer-orders/${rejectTarget.id}/reject`, { reason: rejectReason.trim() })
      message.success('订单已驳回')
      setRejectTarget(null)
      setRejectReason('')
      loadTransferOrders()
    } catch (err) { message.error(platformErrMessage(err)) } finally { setRejectSubmitting(false) }
  }

  // ── 列定义 ──
  const tenantColumns = [
    { title: '企业名称', dataIndex: 'name', width: 160, render: (v, t) => (
      <Space size={6}><span style={{ fontWeight: 600 }}>{v}</span>{t.status === 'DISABLED' && <Tag color="red">已停用</Tag>}</Space>
    ) },
    { title: '套餐', dataIndex: 'plan', width: 150, render: (plan, t) => (
      <Select size="small" value={plan} options={PLAN_OPTIONS} style={{ width: 130 }} onChange={(v) => changePlan(t, v)} />
    ) },
    { title: '空间', dataIndex: 'workspaceType', width: 90, render: (v) => v === 'TEAM' ? '企业' : '个人' },
    { title: '成员', dataIndex: 'userCount', width: 70, align: 'center' },
    { title: '本月 token', dataIndex: 'tokensUsed', width: 110, align: 'right', render: (v) => fmtTokens(v) },
    { title: '月度额度', dataIndex: 'monthlyTokenQuota', width: 110, align: 'right', render: (v) => fmtTokens(v) },
    { title: '订阅到期', dataIndex: 'planExpiresAt', width: 190, render: (v, t) => (
      <DatePicker size="small" allowClear value={v ? dayjs(v) : null} onChange={(d) => changeExpiry(t, d)} placeholder="未设置" style={{ width: 150 }} />
    ) },
    { title: '创建时间', dataIndex: 'createdAt', width: 100, render: fmtDate },
    { title: '操作', key: 'ops', width: 200, fixed: 'right', render: (_, t) => (
      <Space size={4}>
        <Button size="small" type="link" onClick={() => openMembers(t)}>成员</Button>
        <Popconfirm title={t.status === 'ACTIVE' ? `停用 ${t.name}？` : `启用 ${t.name}？`}
          description={t.status === 'ACTIVE' ? '停用后该企业全部成员无法登录' : '恢复该企业所有成员登录'}
          okText="确认" cancelText="取消" okButtonProps={t.status === 'ACTIVE' ? { danger: true } : {}} onConfirm={() => toggleStatus(t)}>
          <Button size="small" type="link" danger={t.status === 'ACTIVE'}>{t.status === 'ACTIVE' ? '停用' : '启用'}</Button>
        </Popconfirm>
      </Space>
    ) },
  ]

  const memberColumns = [
    { title: '用户名', dataIndex: 'username', width: 110 },
    { title: '显示名', dataIndex: 'displayName', width: 100, render: (v) => v || '-' },
    { title: '邮箱', dataIndex: 'email', width: 170, render: (v) => v || '-' },
    { title: '角色', dataIndex: 'role', width: 170, render: (role, u) => (
      <Select size="small" value={role} options={ROLE_OPTIONS} style={{ width: 150 }} onChange={(v) => changeMemberRole(u, v)} />
    ) },
    { title: '状态', dataIndex: 'status', width: 90, render: (s) => <Tag color={s === 'ACTIVE' ? 'green' : 'red'}>{s}</Tag> },
    { title: '最后登录', dataIndex: 'lastLoginAt', width: 150, render: (t) => t ? new Date(t).toLocaleString('zh-CN') : '从未' },
    { title: '操作', key: 'ops', width: 150, render: (_, u) => (
      <Space size={4}>
        <Button size="small" type="link" onClick={() => toggleMemberStatus(u)}>{u.status === 'ACTIVE' ? '禁用' : '启用'}</Button>
        <Popconfirm title={`重置 ${u.username} 的密码？`} description="将生成随机临时密码" okText="重置" cancelText="取消" onConfirm={() => resetPwd(u)}>
          <Button size="small" type="link">重置密码</Button>
        </Popconfirm>
      </Space>
    ) },
  ]

  const transferColumns = [
    { title: '企业名称', dataIndex: 'tenantName', width: 150, render: (v, o) => (
      <Space size={6}><span style={{ fontWeight: 600 }}>{v}</span><Tag>{o.tenantPlan}</Tag></Space>
    ) },
    { title: '商品', dataIndex: 'item', width: 150, render: (v) => ITEM_LABELS[v] || v },
    { title: '金额', dataIndex: 'amountYuan', width: 90, align: 'right', render: (v) => <b>¥{v}</b> },
    { title: '收款渠道', dataIndex: 'payChannel', width: 90, render: (v) => CHANNEL_LABELS[v] || v || '-' },
    { title: '转账单号', dataIndex: 'transferNo', width: 210, render: (v) => (
      <Typography.Text copyable={{ text: v }} style={{ fontSize: 12 }}>{v}</Typography.Text>
    ) },
    { title: '提交人', dataIndex: 'submitter', width: 210, ellipsis: true },
    { title: '提交时间', dataIndex: 'createdAt', width: 150, render: (t) => t ? new Date(t).toLocaleString('zh-CN') : '-' },
    { title: '状态', dataIndex: 'status', width: 110, render: (s, o) => {
      if (s === 'PENDING') return <Tag color="orange">待确认</Tag>
      if (s === 'PAID') return <Tag color="green">已到账</Tag>
      return <div><Tag color="red">已驳回</Tag>{o.rejectReason && <div style={{ fontSize: 12, color: '#999', maxWidth: 180 }}>{o.rejectReason}</div>}</div>
    } },
    { title: '操作', key: 'ops', width: 160, fixed: 'right', render: (_, o) => o.status === 'PENDING' ? (
      <Space size={4}>
        <Popconfirm title={`确认 ${o.tenantName} 已转账 ¥${o.amountYuan}？`}
          description={`确认后自动开通「${ITEM_LABELS[o.item] || o.item}」权益`}
          okText="确认到账" cancelText="取消" onConfirm={() => confirmOrder(o)}>
          <Button size="small" type="link">确认到账</Button>
        </Popconfirm>
        <Button size="small" type="link" danger onClick={() => { setRejectTarget(o); setRejectReason('') }}>驳回</Button>
      </Space>
    ) : o.status === 'PAID'
      ? <span style={{ color: '#999', fontSize: 12 }}>权益已开通</span>
      : <span style={{ color: '#999', fontSize: 12 }}>—</span> },
  ]

  const traceColumns = [
    { title: '', dataIndex: 'status', width: 32, align: 'center', render: (s) => s === 'OK'
      ? <CheckCircleFilled style={{ color: '#52c41a' }} />
      : <CloseCircleFilled style={{ color: '#ff4d4f' }} /> },
    { title: '企业', dataIndex: 'tenantName', width: 120, render: (v, o) => (
      <div style={{ lineHeight: 1.35 }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</div>
        <Tag style={{ marginInlineEnd: 0, fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>{o.tenantPlan}</Tag>
      </div>
    ) },
    { title: '提交人', dataIndex: 'submitter', width: 80, ellipsis: true },
    { title: '功能', dataIndex: 'feature', width: 88, render: (f) => <Tag style={{ marginInlineEnd: 0 }}>{FEATURE_LABEL[f] || f}</Tag> },
    { title: '链路', dataIndex: 'name', ellipsis: true, render: (text, row) => (
      <div style={{ lineHeight: 1.35, overflow: 'hidden' }}>
        <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</div>
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {fmtDateTime(row.createdAt)} · {row.latencyMs}ms · {row.tokens} tok · ¥{row.costCny.toFixed(4)}
        </Typography.Text>
      </div>
    ) },
  ]

  // ── Tab 内容 ──
  const tabItems = [
    {
      key: 'overview',
      label: '运营总览',
      children: (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
            <Card size="small"><Statistic title="企业总数" value={overview?.tenantCount ?? '-'} /></Card>
            <Card size="small"><Statistic title="启用中" value={overview?.activeTenants ?? '-'} suffix={overview ? `/ 停用 ${overview.disabledTenants}` : ''} /></Card>
            <Card size="small"><Statistic title="用户总数" value={overview?.userCount ?? '-'} /></Card>
            <Card size="small"><Statistic title="套餐分布" value={overview
              ? Object.entries(overview.planDistribution).map(([k, v]) => `${k}×${v}`).join('  ')
              : '-'} valueStyle={{ fontSize: 16 }} /></Card>
          </div>
          <Card size="small" title="全部企业租户" extra={
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>新建企业</Button>
          }>
            <Table columns={tenantColumns} dataSource={tenants} rowKey="id" loading={loading} scroll={{ x: 1250 }} size="middle"
              pagination={{ showSizeChanger: false, showTotal: (t) => `共 ${t} 家企业` }} />
          </Card>
        </>
      ),
    },
    {
      key: 'orders',
      label: '转账订单',
      children: (
        <Card size="small" title="转账订单确认" extra={
          <Space>
            <Select size="small" value={transferStatus} options={TRANSFER_STATUS_OPTIONS} style={{ width: 130 }} onChange={(v) => setTransferStatus(v)} />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadTransferOrders()}>刷新</Button>
          </Space>
        }>
          <Table columns={transferColumns} dataSource={transferOrders} rowKey="id" loading={transferLoading} scroll={{ x: 1250 }} size="middle"
            pagination={transferOrders.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
            locale={{ emptyText: transferStatus === 'PENDING' ? '暂无待确认的转账订单' : '暂无订单' }} />
        </Card>
      ),
    },
    {
      key: 'traces',
      label: '调用链路',
      children: <TraceTab />,
    },
    {
      key: 'funnel',
      label: '埋点漏斗',
      children: <FunnelTab />,
    },
  ]

  function TraceTab() {
    return (
      <div>
        <Card size="small" title="跨租户调用链路（排查缺陷用）" extra={
          <Space wrap>
            <Select size="small" value={traceFeature} onChange={(v) => { setTracePage(1); setTraceFeature(v) }} options={FEATURE_OPTIONS} style={{ width: 130 }} />
            <Select size="small" value={traceStatus} onChange={(v) => { setTracePage(1); setTraceStatus(v) }} style={{ width: 110 }}
              options={[{ value: '', label: '全部状态' }, { value: 'OK', label: '成功' }, { value: 'ERROR', label: '失败' }]} />
            <Select size="small" value={tracePlan} onChange={(v) => { setTracePage(1); setTracePlan(v) }} style={{ width: 120 }}
              options={[{ value: '', label: '全部套餐' }, ...PLAN_OPTIONS]} />
            <Button size="small" icon={<ReloadOutlined />} onClick={loadTraces}>刷新</Button>
          </Space>
        }>
          <div style={{ display: 'flex', gap: 16, minHeight: 520 }}>
            <div style={{ width: 640, flexShrink: 0 }}>
              <Spin spinning={traceLoading}>
                <Table size="small" rowKey="id" columns={traceColumns} dataSource={traces.items}
                  tableLayout="fixed"
                  pagination={{ current: tracePage, pageSize: 20, total: traces.total, size: 'small', showSizeChanger: false, onChange: setTracePage }}
                  onRow={(row) => ({ onClick: () => setSelectedTraceId(row.id), style: { cursor: 'pointer' }, className: row.id === selectedTraceId ? 'ant-table-row-selected' : '' })}
                  locale={{ emptyText: <Empty description="暂无链路" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} />
              </Spin>
            </div>
            <div style={{ flex: 1, minWidth: 0, background: '#fff', borderRadius: 8, padding: 16, border: '1px solid #f0f0f0' }}>
              <TraceDetailPanel />
            </div>
          </div>
        </Card>
      </div>
    )
  }

  function TraceDetailPanel() {
    if (traceDetailLoading) return <Spin style={{ display: 'block', marginTop: 120 }} />
    if (!traceDetail) return <Empty description="选择左侧链路查看瀑布" style={{ marginTop: 120 }} />
    const spans = traceDetail.spans || []
    const base = spans.length ? new Date(spans[0].startedAt).getTime() : Date.now()
    const end = spans.reduce((mx, s) => Math.max(mx, new Date(s.startedAt).getTime() + s.durationMs), base)
    const totalMs = Math.max(end - base, 1)

    return (
      <div>
        <Row gutter={12} style={{ marginBottom: 14 }}>
          <Col span={6}>
            <Statistic title="总耗时" value={traceDetail.latencyMs} suffix="ms" valueStyle={{ fontSize: 20 }} />
          </Col>
          <Col span={6}>
            <div>
              <div style={{ fontSize: 13, color: '#8c8c8c', marginBottom: 2 }}>Token</div>
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.2 }}>
                {traceDetail.inputTokens + traceDetail.outputTokens}
              </div>
              <div style={{ fontSize: 11, color: '#8c8c8c', marginTop: 2 }}>
                入 {traceDetail.inputTokens} · 出 {traceDetail.outputTokens}
              </div>
            </div>
          </Col>
          <Col span={6}><Statistic title="费用" value={traceDetail.costCny.toFixed(4)} prefix="¥" valueStyle={{ fontSize: 20 }} /></Col>
          <Col span={6}><Statistic title="Span 数" value={spans.length} valueStyle={{ fontSize: 20 }} /></Col>
        </Row>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
          <Tag color={traceDetail.status === 'OK' ? 'green' : 'red'}>{traceDetail.status}</Tag>
          <Tag>{FEATURE_LABEL[traceDetail.feature] || traceDetail.feature}</Tag>
          <Tag>{traceDetail.tenantPlan}</Tag>
          <Typography.Text strong style={{ fontSize: 13 }}>{traceDetail.tenantName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>· {traceDetail.submitter}</Typography.Text>
          {traceDetail.model && <Tag>{traceDetail.model}</Tag>}
        </div>
        {traceDetail.error && (
          <div style={{ background: '#fff2f0', border: '1px solid #ffccc7', padding: '8px 12px', borderRadius: 6, marginBottom: 12, color: '#cf1322', fontSize: 13 }}>
            {traceDetail.error}
          </div>
        )}

        {/* 图例 */}
        <div style={{ display: 'flex', gap: 16, marginBottom: 8, fontSize: 12 }}>
          {Object.entries(SPAN_META).map(([k, m]) => (
            <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 14, height: 10, background: m.color, borderRadius: 2, display: 'inline-block' }} />
              {m.label}
            </span>
          ))}
        </div>

        {spans.length === 0
          ? <Empty description="该链路没有 span（规则轨/缓存命中为纯本地计算）" style={{ marginTop: 60 }} />
          : (
            <div style={{ maxHeight: 420, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#999', paddingBottom: 4, borderBottom: '1px solid #f0f0f0', marginBottom: 4 }}>
                <span>0ms</span><span>{totalMs}ms</span>
              </div>
              {spans.map((s) => {
                const start = new Date(s.startedAt).getTime() - base
                const widthPct = Math.max((s.durationMs / totalMs) * 100, s.durationMs > 0 ? 0.6 : 0.3)
                const meta = SPAN_META[s.type] || { color: '#9ca3af', label: s.type }
                const pct = ((s.durationMs / totalMs) * 100).toFixed(1)
                const isOpen = expandedSpan === s.id
                return (
                  <div key={s.id} style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ flex: 1, height: 22, position: 'relative', background: '#fafafa', borderRadius: 4, minWidth: 120 }}>
                        <Tooltip title={`${meta.label} · ${s.durationMs}ms (${pct}%)`}>
                          <div onClick={() => setExpandedSpan(isOpen ? null : s.id)} style={{
                            position: 'absolute', left: `${(start / totalMs) * 100}%`,
                            width: `${Math.min(widthPct, 100 - (start / totalMs) * 100)}%`,
                            height: '100%', background: meta.color, borderRadius: 4, cursor: 'pointer',
                            opacity: isOpen ? 1 : 0.85,
                          }} />
                        </Tooltip>
                      </div>
                      <div style={{ width: 180, flexShrink: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        <Tag color={meta.color} style={{ marginInlineEnd: 4, padding: '0 5px' }}>{meta.label}</Tag>
                        <span style={{ fontWeight: 500 }}>{s.name}</span>
                      </div>
                      <div style={{ width: 150, textAlign: 'right', fontSize: 11, color: '#595959', flexShrink: 0, whiteSpace: 'nowrap' }}>
                        +{start}ms · <b>{s.durationMs}ms</b> ({pct}%)
                      </div>
                    </div>
                    {isOpen && <SpanPayload span={s} />}
                  </div>
                )
              })}
            </div>
          )}
      </div>
    )
  }

  function SpanPayload({ span }) {
    const blocks = [
      { title: 'Input', value: span.input },
      { title: 'Output', value: span.output },
      span.metadata ? { title: 'Metadata', value: span.metadata } : null,
    ].filter(Boolean)
    return (
      <div style={{ marginLeft: 32, marginTop: 4, padding: 8, background: '#f9f9f9', borderRadius: 6 }}>
        {(span.inputTokens || span.outputTokens) > 0 && (
          <Typography.Text type="secondary" style={{ marginRight: 16, fontSize: 12 }}>
            tokens：入 {span.inputTokens} / 出 {span.outputTokens} · ¥{Number(span.costCny).toFixed(4)}
          </Typography.Text>
        )}
        {blocks.map((b) => (
          <div key={b.title} style={{ marginTop: 6 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{b.title}</div>
            <pre style={{ margin: 0, fontSize: 11, background: '#fff', padding: 6, borderRadius: 4, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(b.value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    )
  }

  function FunnelTab() {
    const steps = funnelData?.steps || []
    const topCount = steps[0]?.count ?? 0
    return (
      <Card size="small" title="转化漏斗（近 30 天，全量）" extra={
        <Button size="small" icon={<ReloadOutlined />} onClick={loadFunnel}>刷新</Button>
      }>
        <Spin spinning={funnelLoading}>
          {funnelData?.visitor && (
            <Row gutter={16} style={{ marginBottom: 20 }}>
              <Col span={8}><Card size="small"><Statistic title="访客数（匿名设备）" value={funnelData.visitor.visitors} /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="注册数" value={funnelData.visitor.signups} /></Card></Col>
              <Col span={8}><Card size="small"><Statistic title="访客→注册转化率"
                value={funnelData.visitor.signupRate === null ? '-' : `${(funnelData.visitor.signupRate * 100).toFixed(1)}%`} /></Card></Col>
            </Row>
          )}

          {steps.length === 0
            ? <Empty description="暂无漏斗数据" style={{ padding: 40 }} />
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {steps.map((step, i) => {
                  const widthPct = topCount > 0 ? (step.count / topCount) * 100 : 0
                  const fromPrevText = step.fromPrev === null ? '—' : `${(step.fromPrev * 100).toFixed(1)}%`
                  const fromTopText = step.fromTop === null ? '—' : `${(step.fromTop * 100).toFixed(1)}%`
                  return (
                    <div key={step.step} style={{
                      background: `linear-gradient(90deg, #e6f4ff ${widthPct}%, #fafafa ${widthPct}%)`,
                      padding: '10px 16px', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <Tag color="blue">{i + 1}</Tag>
                        <span style={{ fontWeight: 600 }}>{FUNNEL_STEP_LABELS[step.step] || step.step}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontSize: 13 }}>
                        <span><b>{step.count}</b> 人</span>
                        <span style={{ color: '#888' }}>较上一步 {fromPrevText}</span>
                        <span style={{ color: '#888' }}>较注册 {fromTopText}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
        </Spin>
      </Card>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6fa', padding: '20px 28px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>ClauseMind 平台管理控制台</h1>
          <span style={{ color: '#888', fontSize: 12 }}>跨租户超级管理员 · {localStorage.getItem(PLATFORM_USER_KEY) || ''}</span>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={handleRefresh}>刷新</Button>
          <Button icon={<LogoutOutlined />} onClick={logout}>退出</Button>
        </Space>
      </div>

      <Card size="small" styles={{ body: { padding: '0 16px' } }}>
        <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />
      </Card>

      {/* 驳回转账订单 */}
      <Modal title="驳回转账订单" open={!!rejectTarget} confirmLoading={rejectSubmitting}
        okText="确认驳回" okButtonProps={{ danger: true }} cancelText="取消"
        onOk={submitReject} onCancel={() => setRejectTarget(null)}>
        <p style={{ marginTop: 12 }}>
          企业：{rejectTarget?.tenantName} · 商品：{rejectTarget ? (ITEM_LABELS[rejectTarget.item] || rejectTarget.item) : ''} · ¥{rejectTarget?.amountYuan}
        </p>
        <Input.TextArea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
          placeholder="请填写驳回原因（例如：未查询到该笔转账记录）" rows={3} maxLength={200} showCount />
      </Modal>

      {/* 新建企业 */}
      <Modal title="新建企业租户" open={createOpen} onOk={doCreate} confirmLoading={creating}
        onCancel={() => setCreateOpen(false)} okText="创建" cancelText="取消" width={480}>
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="企业名称" rules={[{ required: true, message: '请填写企业名称' }]}>
            <Input placeholder="例如：北京某某科技有限公司" maxLength={100} />
          </Form.Item>
          <Form.Item name="plan" label="初始套餐" initialValue="ENTERPRISE" rules={[{ required: true }]}>
            <Select options={PLAN_OPTIONS} />
          </Form.Item>
          <Form.Item name="adminUsername" label="企业管理员账号" rules={[
            { required: true, message: '请填写管理员用户名' },
            { pattern: /^[a-zA-Z0-9_-]{3,50}$/, message: '3-50 位字母/数字/下划线/中划线' },
          ]}>
            <Input placeholder="该企业的 ADMIN 账号，用于登录" maxLength={50} />
          </Form.Item>
          <Form.Item name="adminPassword" label="管理员初始密码" rules={[{ required: true, message: '请填写初始密码' }, { min: 8, message: '至少 8 位' }]}>
            <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 成员管理 */}
      <Modal title={memberTenant ? `成员管理：${memberTenant.name}` : ''} open={!!memberTenant}
        onCancel={() => setMemberTenant(null)} footer={null} width={980}>
        <Table columns={memberColumns} dataSource={members} rowKey="id" loading={membersLoading} size="middle"
          pagination={false} scroll={{ x: 950 }} />
      </Modal>
    </div>
  )
}
