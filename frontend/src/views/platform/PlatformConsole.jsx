// frontend/src/views/platform/PlatformConsole.jsx
// 平台超管控制台：运营总览 + 全部租户管理（套餐/状态/成员/密码重置）+ 新建租户
// 独立鉴权：platform_token 失效自动跳回 /platform/login
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Card, Table, Button, Tag, Space, Select, Modal, Form, Input, message,
  Popconfirm, Statistic, DatePicker, Typography,
} from 'antd'
import dayjs from 'dayjs'
import { ReloadOutlined, PlusOutlined, LogoutOutlined } from '@ant-design/icons'
import platformApi, { PLATFORM_TOKEN_KEY, PLATFORM_USER_KEY, platformErrMessage } from '@/utils/platformApi.js'

const PLAN_OPTIONS = ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'].map((p) => ({ value: p, label: p }))
const ROLE_OPTIONS = [
  { value: 'ADMIN', label: 'ADMIN · 管理员' },
  { value: 'MANAGER', label: 'MANAGER · 审查负责人' },
  { value: 'USER', label: 'USER · 普通成员' },
  { value: 'READONLY', label: 'READONLY · 只读' },
]

const fmtTokens = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n))
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('zh-CN') : '—')

// 转账订单（用户在收银台提交转账单号 → 超管人工确认到账自动开通）
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

export default function PlatformConsole() {
  const navigate = useNavigate()
  const [overview, setOverview] = useState(null)
  const [tenants, setTenants] = useState([])
  const [loading, setLoading] = useState(true)

  // 新建租户
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm] = Form.useForm()

  // 成员管理
  const [memberTenant, setMemberTenant] = useState(null) // { id, name, plan }
  const [members, setMembers] = useState([])
  const [membersLoading, setMembersLoading] = useState(false)

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [ov, tl] = await Promise.all([platformApi.get('/overview'), platformApi.get('/tenants')])
      setOverview(ov)
      setTenants(tl.tenants || [])
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '数据加载失败'))
    } finally {
      setLoading(false)
    }
  }, [navigate])

  useEffect(() => { loadAll() }, [loadAll])

  // ── 转账订单确认 ──
  const [transferOrders, setTransferOrders] = useState([])
  const [transferStatus, setTransferStatus] = useState('PENDING')
  const [transferLoading, setTransferLoading] = useState(false)
  const [rejectTarget, setRejectTarget] = useState(null) // 待驳回订单
  const [rejectReason, setRejectReason] = useState('')
  const [rejectSubmitting, setRejectSubmitting] = useState(false)

  const loadTransferOrders = useCallback(async (status) => {
    const st = status ?? transferStatus
    setTransferLoading(true)
    try {
      const data = await platformApi.get(`/transfer-orders?status=${st}`)
      setTransferOrders(data.orders || [])
    } catch (err) {
      if (err.response?.status === 401) { navigate('/platform/login', { replace: true }); return }
      message.error(platformErrMessage(err, '转账订单加载失败'))
    } finally {
      setTransferLoading(false)
    }
  }, [navigate, transferStatus])

  useEffect(() => { loadTransferOrders() }, [loadTransferOrders])

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

  const logout = () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY)
    localStorage.removeItem(PLATFORM_USER_KEY)
    navigate('/platform/login', { replace: true })
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
      message.success(next === 'DISABLED' ? `${t.name} 已停用（成员无法登录）` : `${t.name} 已启用`)
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

  // ── 成员操作 ──
  const openMembers = async (t) => {
    setMemberTenant(t)
    setMembersLoading(true)
    try {
      const data = await platformApi.get(`/tenants/${t.id}/users`)
      setMembers(data.users || [])
    } catch (err) { message.error(platformErrMessage(err)) } finally { setMembersLoading(false) }
  }

  const changeMemberRole = async (u, role) => {
    try {
      await platformApi.put(`/tenants/${memberTenant.id}/users/${u.id}`, { role })
      message.success(`${u.username} 角色已改为 ${role}`)
      openMembers(memberTenant)
    } catch (err) { message.error(platformErrMessage(err)) }
  }

  const toggleMemberStatus = async (u) => {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    try {
      await platformApi.put(`/tenants/${memberTenant.id}/users/${u.id}`, { status: next })
      message.success(`${u.username} 已${next === 'DISABLED' ? '禁用' : '启用'}`)
      openMembers(memberTenant)
    } catch (err) { message.error(platformErrMessage(err)) }
  }

  const resetPwd = async (u) => {
    try {
      const data = await platformApi.post(`/tenants/${memberTenant.id}/users/${u.id}/reset-password`)
      Modal.success({
        title: `已重置 ${u.username} 的密码`,
        content: (
          <div>
            <p>临时密码（仅显示一次，请立即复制告知用户）：</p>
            <Typography.Paragraph copyable style={{ fontSize: 16, fontWeight: 600, marginBottom: 0 }}>
              {data.temporaryPassword}
            </Typography.Paragraph>
          </div>
        ),
      })
      openMembers(memberTenant)
    } catch (err) { message.error(platformErrMessage(err)) }
  }

  const tenantColumns = [
    { title: '企业名称', dataIndex: 'name', width: 160, render: (v, t) => (
      <Space size={6}>
        <span style={{ fontWeight: 600 }}>{v}</span>
        {t.status === 'DISABLED' && <Tag color="red">已停用</Tag>}
      </Space>
    ) },
    { title: '套餐', dataIndex: 'plan', width: 150, render: (plan, t) => (
      <Select
        size="small" value={plan} options={PLAN_OPTIONS} style={{ width: 130 }}
        onChange={(v) => changePlan(t, v)}
      />
    ) },
    { title: '空间', dataIndex: 'workspaceType', width: 90, render: (v) => v === 'TEAM' ? '企业' : '个人' },
    { title: '成员', dataIndex: 'userCount', width: 70, align: 'center' },
    { title: '本月 token', dataIndex: 'tokensUsed', width: 110, align: 'right', render: (v) => fmtTokens(v) },
    { title: '月度额度', dataIndex: 'monthlyTokenQuota', width: 110, align: 'right', render: (v) => fmtTokens(v) },
    { title: '订阅到期', dataIndex: 'planExpiresAt', width: 190, render: (v, t) => (
      <DatePicker
        size="small" allowClear
        value={v ? dayjs(v) : null}
        onChange={(d) => changeExpiry(t, d)}
        placeholder="未设置"
        style={{ width: 150 }}
      />
    ) },
    { title: '创建时间', dataIndex: 'createdAt', width: 100, render: fmtDate },
    {
      title: '操作', key: 'ops', width: 200, fixed: 'right',
      render: (_, t) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => openMembers(t)}>成员</Button>
          <Popconfirm
            title={t.status === 'ACTIVE' ? `停用 ${t.name}？` : `启用 ${t.name}？`}
            description={t.status === 'ACTIVE' ? '停用后该企业全部成员无法登录' : '恢复该企业所有成员登录'}
            okText="确认" cancelText="取消"
            okButtonProps={t.status === 'ACTIVE' ? { danger: true } : {}}
            onConfirm={() => toggleStatus(t)}
          >
            <Button size="small" type="link" danger={t.status === 'ACTIVE'}>
              {t.status === 'ACTIVE' ? '停用' : '启用'}
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
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
    {
      title: '操作', key: 'ops', width: 150,
      render: (_, u) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => toggleMemberStatus(u)}>{u.status === 'ACTIVE' ? '禁用' : '启用'}</Button>
          <Popconfirm title={`重置 ${u.username} 的密码？`} description="将生成随机临时密码" okText="重置" cancelText="取消" onConfirm={() => resetPwd(u)}>
            <Button size="small" type="link">重置密码</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const transferColumns = [
    { title: '企业名称', dataIndex: 'tenantName', width: 150, render: (v, o) => (
      <Space size={6}>
        <span style={{ fontWeight: 600 }}>{v}</span>
        <Tag>{o.tenantPlan}</Tag>
      </Space>
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
      return (
        <div>
          <Tag color="red">已驳回</Tag>
          {o.rejectReason && <div style={{ fontSize: 12, color: '#999', maxWidth: 180 }}>{o.rejectReason}</div>}
        </div>
      )
    } },
    {
      title: '操作', key: 'ops', width: 160, fixed: 'right',
      render: (_, o) => o.status === 'PENDING' ? (
        <Space size={4}>
          <Popconfirm
            title={`确认 ${o.tenantName} 已转账 ¥${o.amountYuan}？`}
            description={`确认后自动开通「${ITEM_LABELS[o.item] || o.item}」权益`}
            okText="确认到账" cancelText="取消"
            onConfirm={() => confirmOrder(o)}
          >
            <Button size="small" type="link">确认到账</Button>
          </Popconfirm>
          <Button size="small" type="link" danger onClick={() => { setRejectTarget(o); setRejectReason('') }}>驳回</Button>
        </Space>
      ) : o.status === 'PAID'
        ? <span style={{ color: '#999', fontSize: 12 }}>权益已开通</span>
        : <span style={{ color: '#999', fontSize: 12 }}>—</span>
    },
  ]

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6fa', padding: '20px 28px' }}>
      {/* 顶栏 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0 }}>ClauseMind 平台管理控制台</h1>
          <span style={{ color: '#888', fontSize: 12 }}>跨租户超级管理员 · {localStorage.getItem(PLATFORM_USER_KEY) || ''}</span>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => { loadAll(); loadTransferOrders() }}>刷新</Button>
          <Button icon={<LogoutOutlined />} onClick={logout}>退出</Button>
        </Space>
      </div>

      {/* 统计卡 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <Card size="small"><Statistic title="企业总数" value={overview?.tenantCount ?? '-'} /></Card>
        <Card size="small"><Statistic title="启用中" value={overview?.activeTenants ?? '-'} suffix={overview ? `/ 停用 ${overview.disabledTenants}` : ''} /></Card>
        <Card size="small"><Statistic title="用户总数" value={overview?.userCount ?? '-'} /></Card>
        <Card size="small">
          <Statistic title="套餐分布" value={overview
            ? Object.entries(overview.planDistribution).map(([k, v]) => `${k}×${v}`).join('  ')
            : '-'} valueStyle={{ fontSize: 16 }} />
        </Card>
      </div>

      {/* 租户表 */}
      <Card size="small" title="全部企业租户" extra={
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>
          新建企业
        </Button>
      }>
        <Table
          columns={tenantColumns} dataSource={tenants} rowKey="id" loading={loading}
          scroll={{ x: 1250 }} size="middle"
          pagination={{ showSizeChanger: false, showTotal: (t) => `共 ${t} 家企业` }}
        />
      </Card>

      {/* 转账订单确认（用户转账支付 → 超管人工确认到账自动开通） */}
      <Card
        size="small" title="转账订单确认" style={{ marginTop: 18 }}
        extra={
          <Space>
            <Select
              size="small" value={transferStatus} options={TRANSFER_STATUS_OPTIONS}
              style={{ width: 130 }} onChange={(v) => setTransferStatus(v)}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadTransferOrders()}>刷新</Button>
          </Space>
        }
      >
        <Table
          columns={transferColumns} dataSource={transferOrders} rowKey="id" loading={transferLoading}
          scroll={{ x: 1250 }} size="middle"
          pagination={transferOrders.length > 10 ? { pageSize: 10, showSizeChanger: false } : false}
          locale={{ emptyText: transferStatus === 'PENDING' ? '暂无待确认的转账订单' : '暂无订单' }}
        />
      </Card>

      {/* 驳回转账订单（需填写原因告知用户） */}
      <Modal
        title="驳回转账订单" open={!!rejectTarget}
        confirmLoading={rejectSubmitting}
        okText="确认驳回" okButtonProps={{ danger: true }} cancelText="取消"
        onOk={submitReject} onCancel={() => setRejectTarget(null)}
      >
        <p style={{ marginTop: 12 }}>
          企业：{rejectTarget?.tenantName} · 商品：{rejectTarget ? (ITEM_LABELS[rejectTarget.item] || rejectTarget.item) : ''} · ¥{rejectTarget?.amountYuan}
        </p>
        <Input.TextArea
          value={rejectReason}
          onChange={(e) => setRejectReason(e.target.value)}
          placeholder="请填写驳回原因（例如：未查询到该笔转账记录）"
          rows={3} maxLength={200} showCount
        />
      </Modal>

      {/* 新建企业 */}
      <Modal
        title="新建企业租户" open={createOpen} onOk={doCreate} confirmLoading={creating}
        onCancel={() => setCreateOpen(false)} okText="创建" cancelText="取消" width={480}
      >
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
          <Form.Item name="adminPassword" label="管理员初始密码" rules={[
            { required: true, message: '请填写初始密码' },
            { min: 8, message: '至少 8 位' },
          ]}>
            <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 成员管理 */}
      <Modal
        title={memberTenant ? `成员管理：${memberTenant.name}` : ''} open={!!memberTenant}
        onCancel={() => setMemberTenant(null)} footer={null} width={980}
      >
        <Table
          columns={memberColumns} dataSource={members} rowKey="id" loading={membersLoading} size="middle"
          pagination={false} scroll={{ x: 950 }}
        />
      </Modal>
    </div>
  )
}
