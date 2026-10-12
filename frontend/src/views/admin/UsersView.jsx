// frontend/src/views/admin/UsersView.jsx
// 用户管理：列表/搜索/分页 + 新增用户、编辑角色状态、启用/禁用、软删除
// 后端：GET/POST /api/admin/users、PUT/DELETE /api/admin/users/:id（ADMIN only，防自锁保护在服务端）
import { useState, useEffect } from 'react'
import { Table, Button, Tag, Space, Input, Select, Form, Modal, message, Popconfirm } from 'antd'
import { SearchOutlined, UserAddOutlined } from '@ant-design/icons'
import http from '@/utils/http.js'
import { useAuthStore } from '@/stores/auth.js'

const roleColors = {
  ADMIN: 'red',
  MANAGER: 'orange',
  USER: 'blue',
  READONLY: 'default',
}

const statusColors = {
  ACTIVE: 'green',
  DISABLED: 'red',
  PENDING: 'gold',
}

const ROLE_OPTIONS = [
  { value: 'ADMIN', label: 'ADMIN · 管理员' },
  { value: 'MANAGER', label: 'MANAGER · 审查负责人' },
  { value: 'USER', label: 'USER · 普通成员' },
  { value: 'READONLY', label: 'READONLY · 只读' },
]

const ROLE_DESC = {
  ADMIN: '全部管理权限（用户/规则/账单）',
  MANAGER: '分配审查任务、执行人工终审',
  USER: '上传合同、发起审查',
  READONLY: '仅查看，不可发起操作',
}

export default function UsersView() {
  const currentUser = useAuthStore((s) => s.user)
  const selfId = currentUser?.id || currentUser?.userId || ''

  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [pagination, setPagination] = useState({ current: 1, pageSize: 20, total: 0 })

  // 新增用户
  const [createOpen, setCreateOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createForm] = Form.useForm()
  // 编辑角色/状态
  const [editing, setEditing] = useState(null) // 当前编辑的用户行
  const [savingEdit, setSavingEdit] = useState(false)
  const [editForm] = Form.useForm()

  const fetchUsers = async (page = 1) => {
    setLoading(true)
    try {
      const data = await http.get('/admin/users', { params: { page, pageSize: 20, q: search || undefined } })
      setUsers(data.users || [])
      setPagination((prev) => ({ ...prev, current: page, total: data.total || 0 }))
    } catch (err) {
      setUsers([])
      message.error(err.response?.data?.error?.message || '用户列表加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchUsers() }, [])

  // ── 新增 ──
  const doCreate = async () => {
    const v = await createForm.validateFields()
    setCreating(true)
    try {
      await http.post('/admin/users', v)
      message.success(`用户 ${v.username} 已创建`)
      setCreateOpen(false)
      createForm.resetFields()
      fetchUsers(1)
    } catch (err) {
      message.error(err.response?.data?.error?.message || '创建失败')
    } finally {
      setCreating(false)
    }
  }

  // ── 编辑（角色 + 状态）──
  const openEdit = (u) => {
    setEditing(u)
    editForm.setFieldsValue({ role: u.role, status: u.status })
  }

  const doSaveEdit = async () => {
    const v = await editForm.validateFields()
    setSavingEdit(true)
    try {
      await http.put(`/admin/users/${editing.id}`, v)
      message.success('已保存')
      setEditing(null)
      fetchUsers(pagination.current)
    } catch (err) {
      message.error(err.response?.data?.error?.message || '保存失败')
    } finally {
      setSavingEdit(false)
    }
  }

  // ── 快捷启用/禁用 ──
  const toggleStatus = async (u) => {
    const next = u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE'
    try {
      await http.put(`/admin/users/${u.id}`, { status: next })
      message.success(next === 'DISABLED' ? `已禁用 ${u.username}` : `已启用 ${u.username}`)
      fetchUsers(pagination.current)
    } catch (err) {
      message.error(err.response?.data?.error?.message || '操作失败')
    }
  }

  // ── 删除（后端软删除=置 DISABLED，保留审计记录）──
  const doDelete = async (u) => {
    try {
      await http.delete(`/admin/users/${u.id}`)
      message.success(`已删除 ${u.username}（账号已禁用，审计记录保留）`)
      fetchUsers(pagination.current)
    } catch (err) {
      message.error(err.response?.data?.error?.message || '删除失败')
    }
  }

  const isSelf = (u) => u.id === selfId

  const columns = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 120 },
    { title: '邮箱', dataIndex: 'email', key: 'email', width: 200, render: (v) => v || '-' },
    { title: '显示名', dataIndex: 'displayName', key: 'displayName', width: 120, render: (v) => v || '-' },
    {
      title: '角色', dataIndex: 'role', key: 'role', width: 110,
      render: (role) => <Tag color={roleColors[role] || 'default'}>{role}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', key: 'status', width: 90,
      render: (status) => <Tag color={statusColors[status] || 'default'}>{status}</Tag>,
    },
    {
      title: '最后登录', dataIndex: 'lastLoginAt', key: 'lastLoginAt', width: 170,
      render: (t) => t ? new Date(t).toLocaleString('zh-CN') : '-',
    },
    { title: '注册时间', dataIndex: 'createdAt', key: 'createdAt', width: 170,
      render: (t) => new Date(t).toLocaleString('zh-CN'),
    },
    {
      title: '操作', key: 'actions', width: 220, fixed: 'right',
      render: (_, u) => isSelf(u)
        ? <span style={{ color: '#999' }}>当前账号（不可自改）</span>
        : (
          <Space size={4}>
            <Button size="small" type="link" onClick={() => openEdit(u)}>编辑</Button>
            <Button size="small" type="link" onClick={() => toggleStatus(u)}>
              {u.status === 'ACTIVE' ? '禁用' : '启用'}
            </Button>
            {u.status !== 'DISABLED' && (
              <Popconfirm
                title={`确认删除 ${u.username}？`}
                description="删除为软删除：账号被禁用，审计记录保留。"
                okText="删除" cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => doDelete(u)}
              >
                <Button size="small" type="link" danger>删除</Button>
              </Popconfirm>
            )}
          </Space>
        ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Space>
          <Input
            prefix={<SearchOutlined />}
            placeholder="搜索用户名/邮箱"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onPressEnter={() => fetchUsers(1)}
            style={{ width: 250 }}
            allowClear
          />
          <Button onClick={() => fetchUsers(1)}>搜索</Button>
        </Space>
        <Button type="primary" icon={<UserAddOutlined />} onClick={() => { createForm.resetFields(); setCreateOpen(true) }}>
          新增用户
        </Button>
      </div>

      <Table
        columns={columns}
        dataSource={users}
        rowKey="id"
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={{
          ...pagination,
          showSizeChanger: false,
          showTotal: (total) => `共 ${total} 个用户`,
          onChange: (page) => fetchUsers(page),
        }}
        size="middle"
      />

      {/* 新增用户 */}
      <Modal
        title="新增用户"
        open={createOpen}
        onOk={doCreate}
        confirmLoading={creating}
        onCancel={() => setCreateOpen(false)}
        okText="创建"
        cancelText="取消"
        width={480}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="username" label="用户名" rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[a-zA-Z0-9_-]{3,50}$/, message: '3-50 位字母/数字/下划线/中划线' },
          ]}>
            <Input placeholder="用于登录，如 zhangsan" maxLength={50} />
          </Form.Item>
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="选填，默认同用户名" maxLength={100} />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[
            { type: 'email', message: '邮箱格式不正确' },
          ]}>
            <Input placeholder="选填，可用于验证码登录" maxLength={100} />
          </Form.Item>
          <Form.Item name="password" label="初始密码" rules={[
            { required: true, message: '请输入初始密码' },
            { min: 8, message: '至少 8 位' },
          ]}>
            <Input.Password placeholder="至少 8 位，请告知用户首次登录后自行修改" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="role" label="角色" initialValue="USER" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 编辑角色/状态 */}
      <Modal
        title={editing ? `编辑用户：${editing.username}` : ''}
        open={!!editing}
        onOk={doSaveEdit}
        confirmLoading={savingEdit}
        onCancel={() => setEditing(null)}
        okText="保存"
        cancelText="取消"
        width={440}
      >
        {editing && (
          <Form form={editForm} layout="vertical" style={{ marginTop: 12 }}>
            <Form.Item name="role" label="角色" rules={[{ required: true }]} extra={ROLE_DESC[editing.role]}>
              <Select options={ROLE_OPTIONS} />
            </Form.Item>
            <Form.Item name="status" label="状态" rules={[{ required: true }]}>
              <Select options={[
                { value: 'ACTIVE', label: 'ACTIVE · 启用' },
                { value: 'DISABLED', label: 'DISABLED · 禁用（无法登录）' },
              ]} />
            </Form.Item>
          </Form>
        )}
      </Modal>
    </div>
  )
}
