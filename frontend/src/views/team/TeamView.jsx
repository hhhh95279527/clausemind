// frontend/src/views/team/TeamView.jsx
// 团队席位与成员管理（对齐 docs/prototype/team.html）
// - 席位使用 / 角色分布 / 演示模式说明 三统计卡
// - 成员表：邀请（演示环境直接创建账号入租户）、编辑角色、移除
// - 超席位 → PLAN_LIMIT/SEAT_LIMIT → 增购引导
// - 个人空间：加锁付费墙
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Avatar, Button, Empty, Form, Input, Modal, Popconfirm, Select, Spin, Table, Tag, message,
} from 'antd'
import { SafetyCertificateFilled, TeamOutlined, UserAddOutlined } from '@ant-design/icons'
import http from '@/utils/http.js'
import { useMeStore } from '@/stores/me.js'
import { useAuthStore } from '@/stores/auth.js'
import css from './team.module.css'

const ROLE_TAG = { ADMIN: 'purple', MANAGER: 'blue', USER: 'default' }
const ROLE_LABEL = { ADMIN: '负责人', MANAGER: '法务', USER: '普通成员' }

function formatLogin(iso) {
  if (!iso) return '尚未登录'
  const d = new Date(iso)
  const now = new Date()
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diffDays === 0) return `今天 ${hm}`
  if (diffDays === 1) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export default function TeamView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const currentUser = useAuthStore((s) => s.user)
  const isTeamSpace = entitlement?.workspaceType === 'TEAM'
  const isAdmin = currentUser?.role === 'ADMIN'

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [created, setCreated] = useState(null) // 一次性入参结果
  const [submitting, setSubmitting] = useState(false)
  const [editMember, setEditMember] = useState(null)
  const [editRole, setEditRole] = useState('USER')
  const [seatBlock, setSeatBlock] = useState(null)
  const [form] = Form.useForm()

  const loadMembers = async () => {
    setLoading(true)
    try {
      setData(await http.get('/team/members'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => {
    if (isTeamSpace) loadMembers()
  }, [isTeamSpace])

  const roleCounts = useMemo(() => {
    const c = { ADMIN: 0, MANAGER: 0, USER: 0 }
    for (const m of data?.members || []) if (m.role in c) c[m.role] += 1
    return c
  }, [data])

  // ── 个人空间：加锁付费墙（原型 #locked 文案）──
  if (entitlement && !isTeamSpace) {
    return (
      <div className={css.lockWrap}>
        <div className={css.lockCard}>
          <div className={css.lockIcon}><SafetyCertificateFilled /></div>
          <h3>团队席位为团队版 / 企业版权益</h3>
          <p className={css.lockMuted}>个人版（PERSONAL）为单人空间，不支持成员协作</p>
          <ul className={css.lockFeats}>
            <li><span className={css.tick}>✓</span>5 席起，三角色协作审批</li>
            <li><span className={css.tick}>✓</span>Playbook 公司规则与合同台账全生命周期</li>
            <li><span className={css.tick}>✓</span>飞书集成、邀请成员与席位管理</li>
          </ul>
          <Button type="primary" size="large" block onClick={() => navigate('/pricing')}>了解团队版 TEAM</Button>
        </div>
      </div>
    )
  }

  if (!data) {
    return <div className={css.center}><Spin size="large" tip="加载团队信息…" /></div>
  }

  const seats = data.seats // null = 不限
  const used = data.usedSeats
  const remain = seats === null ? null : Math.max(seats - used, 0)
  const seatPct = seats === null ? 0 : Math.min(100, Math.round((used / seats) * 100))

  const openInvite = () => {
    setCreated(null)
    form.resetFields()
    form.setFieldsValue({ role: 'USER' })
    setInviteOpen(true)
  }

  const submitInvite = async () => {
    const values = await form.validateFields()
    setSubmitting(true)
    try {
      const res = await http.post('/team/members', values, { skipErrorToast: true })
      setCreated(res)
      message.success('成员已加入团队')
      loadMembers()
    } catch (err) {
      const e = err.response?.data?.error
      if (err.response?.status === 403 && e?.code === 'PLAN_LIMIT' && e?.reason === 'SEAT_LIMIT') {
        setInviteOpen(false)
        setSeatBlock(e.message)
      } else {
        message.error(e?.message || '邀请失败，请稍后重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const submitRole = async () => {
    setSubmitting(true)
    try {
      await http.patch(`/team/members/${editMember.id}/role`, { role: editRole })
      message.success('角色已更新')
      setEditMember(null)
      loadMembers()
    } catch (err) {
      message.error(err.response?.data?.error?.message || '操作失败')
    } finally {
      setSubmitting(false)
    }
  }

  const removeMember = async (m) => {
    await http.delete(`/team/members/${m.id}`)
    message.success(`已移除成员 ${m.displayName || m.username}`)
    loadMembers()
  }

  const columns = [
    {
      title: '姓名',
      dataIndex: 'displayName',
      render: (_, m) => (
        <span className={css.nameCell}>
          <Avatar size="small" style={{ backgroundColor: m.role === 'ADMIN' ? '#7c3aed' : m.role === 'MANAGER' ? '#2563eb' : '#6b7280' }}>
            {(m.displayName || m.username || '?').slice(0, 1)}
          </Avatar>
          <b>{m.displayName || m.username}</b>
          {m.id === currentUser?.id && <span className={css.meHint}>（我）</span>}
        </span>
      ),
    },
    { title: '邮箱', dataIndex: 'email', render: (v) => <span className={css.muted}>{v || '—'}</span> },
    {
      title: '角色', dataIndex: 'role', width: 110,
      render: (r) => <Tag color={ROLE_TAG[r]}>{ROLE_LABEL[r] || r}</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s) => (s === 'ACTIVE'
        ? <Tag color="green" className={css.dotTag}>已激活</Tag>
        : <Tag color="default">已停用</Tag>),
    },
    {
      title: '最近登录', dataIndex: 'lastLoginAt', width: 140,
      render: (v) => <span className={css.muted}>{formatLogin(v)}</span>,
    },
    {
      title: '操作', width: 160,
      render: (_, m) => {
        if (!isAdmin) return <span className={css.muted}>—</span>
        const isSelf = m.id === currentUser?.id
        return (
          <span className={css.rowActions}>
            <a onClick={() => { setEditMember(m); setEditRole(m.role) }}>编辑角色</a>
            {isSelf
              ? <span className={css.actionDisabled}>移除</span>
              : (
                <Popconfirm
                  title={`移除成员「${m.displayName || m.username}」？`}
                  description="移除后该账号将无法登录本团队空间"
                  okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
                  onConfirm={() => removeMember(m)}
                >
                  <a className={css.danger}>移除</a>
                </Popconfirm>
              )}
          </span>
        )
      },
    },
  ]

  return (
    <div className={css.page}>
      {/* 页头 */}
      <div className={css.toolbar}>
        <div>
          <div className={css.title}>成员与角色</div>
          <div className={css.subtitle}>
            当前 {data.members.length} 名成员{seats === null ? '' : ` · 剩余 ${remain} 个可用席位`}
          </div>
        </div>
        <div className={css.toolbarRight}>
          <Button onClick={() => navigate('/billing')}>增购席位</Button>
          {isAdmin && (
            <Button type="primary" icon={<UserAddOutlined />} onClick={openInvite}>邀请成员</Button>
          )}
        </div>
      </div>

      {/* 统计卡 */}
      <div className={css.statGrid}>
        <div className={css.statCard}>
          <div className={css.statTop}><TeamOutlined /> 席位使用</div>
          <div className={css.statNum}>
            {used}<span className={css.statUnit}> / {seats === null ? '不限席位' : `${seats} 席`}</span>
          </div>
          {seats === null ? (
            <div className={css.progress}><i style={{ width: '100%' }} /></div>
          ) : (
            <div className={css.progress}><i style={{ width: `${seatPct}%` }} /></div>
          )}
          <div className={css.statFoot}>
            {seats === null
              ? <><Tag color="purple">{data.planLabel}</Tag>席位不限量</>
              : <>剩余 {remain} 席 · <a onClick={() => navigate('/billing')}>增购席位 ¥99/席/月</a></>}
          </div>
        </div>

        <div className={css.statCard}>
          <div className={css.statTop}><SafetyCertificateFilled /> 角色分布</div>
          <div className={css.roleSummary}>负责人 {roleCounts.ADMIN} · 法务 {roleCounts.MANAGER} · 成员 {roleCounts.USER}</div>
          <div className={css.roleLine}>
            <Tag color="purple">负责人</Tag><Tag color="blue">法务</Tag><Tag>普通成员</Tag>
          </div>
          <div className={css.statFoot}>审批终审仅负责人可操作</div>
        </div>

        <div className={css.statCard}>
          <div className={css.statTop}><UserAddOutlined /> 邀请方式</div>
          <div className={css.roleSummary}>演示环境直接入团队</div>
          <div className={css.statFoot}>
            新成员凭邮箱与一次性初始密码直接登录；正式环境将改为邮件接受邀请流程
          </div>
        </div>
      </div>

      {/* 成员表 */}
      <div className={css.panel}>
        <div className={css.panelHead}>
          <h3>团队成员</h3>
          <span className={css.muted}>共 {data.members.length} 条记录</span>
        </div>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={data.members}
          loading={loading}
          pagination={false}
          size="middle"
          locale={{ emptyText: <Empty description="暂无成员" /> }}
        />
        {!isAdmin && <div className={css.readonlyHint}>仅团队负责人可邀请成员与调整角色</div>}
      </div>

      {/* 三角色权限对照 */}
      <div className={css.panel}>
        <div className={css.panelHead}>
          <h3>三角色权限对照</h3>
          <span className={css.muted}>审批流：成员上传 → 法务确认 → 负责人终审</span>
        </div>
        <table className={css.compareTable}>
          <thead>
            <tr><th>能力</th><th>普通成员</th><th>法务</th><th>负责人</th></tr>
          </thead>
          <tbody>
            <tr><td>上传合同 / 发起审查</td><td className={css.tickCell}>✓</td><td className={css.tickCell}>✓</td><td className={css.tickCell}>✓</td></tr>
            <tr><td>审查确认（采纳 / 修改风险项）</td><td className={css.crossCell}>✕</td><td className={css.tickCell}>✓</td><td className={css.tickCell}>✓</td></tr>
            <tr><td>审批终审（生成意见书）</td><td className={css.crossCell}>✕</td><td className={css.crossCell}>✕</td><td className={css.tickCell}>✓</td></tr>
            <tr><td>Playbook 规则管理</td><td className={css.crossCell}>✕</td><td className={css.tickCell}>✓</td><td className={css.tickCell}>✓</td></tr>
            <tr><td>成员与席位管理、套餐变更</td><td className={css.crossCell}>✕</td><td className={css.crossCell}>✕</td><td className={css.tickCell}>✓</td></tr>
          </tbody>
        </table>
      </div>

      {/* 即将上线 */}
      <div className={css.infoBanner}>
        <Tag>即将上线</Tag>
        <div><b>审批流配置（按金额 / 合同类型自动分派）</b>即将上线：例如 5 万元以下合同法务直接终审，商务合同自动分派对应法务。</div>
      </div>

      {/* 邀请成员 */}
      <Modal
        open={inviteOpen}
        title={created ? null : '邀请成员加入团队'}
        footer={null}
        onCancel={() => setInviteOpen(false)}
        width={480}
        destroyOnClose
      >
        {!created ? (
          <>
            <div className={css.inviteTip}>
              <b>演示环境将直接创建账号并入团队；</b>邮件邀请接受流程即将上线。
            </div>
            <Form form={form} layout="vertical">
              <Form.Item
                name="displayName" label="姓名"
                rules={[{ required: true, message: '请填写成员姓名' }, { max: 100 }]}
              >
                <Input placeholder="如：赵某" maxLength={100} />
              </Form.Item>
              <Form.Item
                name="email" label="邮箱"
                rules={[
                  { required: true, message: '请填写邮箱' },
                  { type: 'email', message: '邮箱格式不正确' },
                ]}
              >
                <Input placeholder="用于登录与接收通知的邮箱" />
              </Form.Item>
              <Form.Item name="role" label="角色" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'USER', label: '普通成员（上传合同）' },
                    { value: 'MANAGER', label: '法务（审查确认 + 规则管理）' },
                    { value: 'ADMIN', label: '负责人（审批终审 + 团队管理）' },
                  ]}
                />
              </Form.Item>
            </Form>
            <div className={css.inviteFoot}>
              邀请成功后占用 1 个团队席位，{seats === null ? '当前席位不限量' : `当前剩余 ${remain} 席`}。
            </div>
            <div className={css.modalActions}>
              <Button onClick={() => setInviteOpen(false)}>取消</Button>
              <Button type="primary" loading={submitting} onClick={submitInvite}>确定邀请</Button>
            </div>
          </>
        ) : (
          <div className={css.inviteDone}>
            <div className={css.doneIcon}>✓</div>
            <h3>邀请已发送（演示环境已直接入团队）</h3>
            <p className={css.muted}>新成员可使用邮箱直接登录企业空间；正式环境将改为邮件接受邀请流程。</p>
            <div className={css.credBox}>
              <div><span className={css.muted}>登录邮箱：</span><b>{created.member.email}</b></div>
              <div><span className={css.muted}>登录账号：</span><b>{created.username}</b></div>
              <div><span className={css.muted}>初始密码：</span><b className={css.credPw}>{created.initialPassword}</b></div>
              <div className={css.credWarn}>初始密码仅显示一次，请通过安全方式转交成员</div>
            </div>
            <Button type="primary" block onClick={() => setInviteOpen(false)}>查看成员列表</Button>
          </div>
        )}
      </Modal>

      {/* 编辑角色 */}
      <Modal
        open={!!editMember}
        title="编辑成员角色"
        onCancel={() => setEditMember(null)}
        onOk={submitRole}
        confirmLoading={submitting}
        okText="保存" cancelText="取消"
        destroyOnClose
      >
        {editMember && (
          <>
            <p>成员：<b>{editMember.displayName || editMember.username}</b>（{editMember.email}）</p>
            <Select
              value={editRole}
              onChange={setEditRole}
              style={{ width: '100%' }}
              options={[
                { value: 'USER', label: '普通成员（上传合同）' },
                { value: 'MANAGER', label: '法务（审查确认 + 规则管理）' },
                { value: 'ADMIN', label: '负责人（审批终审 + 团队管理）' },
              ]}
            />
          </>
        )}
      </Modal>

      {/* 席位已满 */}
      <Modal
        open={!!seatBlock}
        title="团队席位已满"
        footer={null}
        onCancel={() => setSeatBlock(null)}
        destroyOnClose
      >
        <p>{seatBlock}</p>
        <p className={css.muted}>增购席位后可继续邀请成员；也可升级至企业版获得不限席位。</p>
        <div className={css.modalActions}>
          <Button onClick={() => setSeatBlock(null)}>稍后再说</Button>
          <Button type="primary" onClick={() => navigate('/billing')}>增购席位 ¥99/席/月</Button>
        </div>
      </Modal>
    </div>
  )
}
