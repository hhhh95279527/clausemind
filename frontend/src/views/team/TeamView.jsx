// frontend/src/views/team/TeamView.jsx
// 团队席位与成员管理：
// - 席位使用 / 角色分布 / 链接邀请说明 三统计卡
// - 邀请成员：生成 7 天有效邀请链接 → 微信/飞书分享 → 受邀人自助注册 → 负责人审批后可登录
// - 成员表：待审批（PENDING）行可通过/拒绝；激活成员可编辑角色/移除
// - 超席位 → PLAN_LIMIT/SEAT_LIMIT → 增购引导
// - 个人空间：加锁付费墙
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Avatar, Button, Empty, Modal, Popconfirm, Select, Spin, Table, Tag, message,
} from 'antd'
import { SafetyCertificateFilled, TeamOutlined, UserAddOutlined, LinkOutlined, QrcodeOutlined } from '@ant-design/icons'
import { QRCodeSVG } from 'qrcode.react'
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

/** 复制文本（clipboard API + execCommand 降级） */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { /* noop */ }
    document.body.removeChild(ta)
    return ok
  }
}

export default function TeamView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const currentUser = useAuthStore((s) => s.user)
  const isTeamSpace = entitlement?.workspaceType === 'TEAM'
  const isAdmin = currentUser?.role === 'ADMIN'

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  // 邀请弹窗：confirm=极简确认步，share=微信/飞书分享步
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteStep, setInviteStep] = useState('confirm')
  const [inviteInfo, setInviteInfo] = useState(null)
  const [creating, setCreating] = useState(false)
  const [actionId, setActionId] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [editMember, setEditMember] = useState(null)
  const [editRole, setEditRole] = useState('USER')
  const [seatBlock, setSeatBlock] = useState(null)

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

  const pendingMembers = useMemo(
    () => (data?.members || []).filter((m) => m.status === 'PENDING'),
    [data],
  )

  // 角色分布仅统计已激活成员（待审批不参与）
  const roleCounts = useMemo(() => {
    const c = { ADMIN: 0, MANAGER: 0, USER: 0 }
    for (const m of data?.members || []) {
      if (m.status === 'ACTIVE' && m.role in c) c[m.role] += 1
    }
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

  // ── 邀请：生成链接 → 分享 ─────────────────────────────────────────
  const openInvite = () => {
    setInviteInfo(null)
    setInviteStep('confirm')
    setInviteOpen(true)
  }

  const confirmInvite = async () => {
    setCreating(true)
    try {
      const res = await http.post('/team/invites', {})
      setInviteInfo(res)
      setInviteStep('share')
    } catch {
      // 错误提示已由 http 拦截器统一 toast
    } finally {
      setCreating(false)
    }
  }

  const isMobileDevice = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)

  // 通过操作系统注册的 URL 协议直接唤起 IM 客户端（锚点点击必须在点击手势的同步调用栈内）。
  // 浏览器弹「是否打开 xx」或客户端切到前台时窗口会失焦，据此判断是否唤起成功。
  const launchByProtocol = (schemeUrl) => new Promise((resolve) => {
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onLeave)
      window.removeEventListener('pagehide', onLeave)
      window.removeEventListener('blur', onLeave)
      resolve(ok)
    }
    const onLeave = () => finish(true)
    document.addEventListener('visibilitychange', onLeave)
    window.addEventListener('pagehide', onLeave)
    window.addEventListener('blur', onLeave)
    const timer = setTimeout(() => finish(false), 1500)
    const a = document.createElement('a')
    a.href = schemeUrl
    // 不用 display:none（个别浏览器认为不可点击），移出屏幕即可
    a.style.cssText = 'position:fixed;left:-9999px;top:-9999px;'
    document.body.appendChild(a)
    a.click()
    a.remove()
  })

  const shareVia = async (channel) => {
    if (!inviteInfo?.url) return
    // 手机端：系统分享面板（可直接选微信/飞书，内容自动带入）；桌面端 navigator.share
    // 弹出的是 Windows 分享面板（不含桌面版微信/飞书），必须跳过
    if (isMobileDevice() && navigator.canShare?.({ url: inviteInfo.url }) && navigator.share) {
      try {
        await navigator.share({
          title: `邀请你加入「${inviteInfo.tenantName}」团队`,
          text: `诚邀你加入「${inviteInfo.tenantName}」，一起使用 ClauseMind 智能合同审查：`,
          url: inviteInfo.url,
        })
        return
      } catch (err) {
        if (err?.name === 'AbortError') return
      }
    }
    // 桌面端：直接用 feishu:// / weixin:// 协议唤起本机客户端（浏览器会先弹一次确认，点「打开」即可）
    const scheme = channel === 'feishu'
      ? 'feishu://applink/client/op/open'
      : 'weixin://'
    const launchedPromise = launchByProtocol(scheme)
    const ok = await copyText(inviteInfo.url)
    const opened = await launchedPromise
    if (channel === 'feishu' && !opened) {
      // 协议被拦截或未安装飞书：消息条里给官方 AppLink 兜底链接（用户点击本身是新手势，不会被拦截）
      message.open({
        duration: 8,
        content: (
          <span>
            链接已复制。若飞书没有自动弹出，
            <a href="https://applink.feishu.cn/client/op/open?lk_unique=true" target="_blank" rel="noreferrer">
              点此打开飞书
            </a>
            （或手动打开飞书粘贴）
          </span>
        ),
      })
      return
    }
    if (channel === 'wechat' && !opened) {
      message.warning('链接已复制，但未唤起微信，请手动打开微信粘贴发送（需电脑已安装微信）', 6)
      return
    }
    if (ok) {
      message.success(
        channel === 'wechat'
          ? '邀请链接已复制；若浏览器弹出「打开微信」请点允许，再选择同事粘贴发送'
          : '邀请链接已复制；若浏览器弹出「打开飞书」请点允许，再选择同事粘贴发送',
        5,
      )
    } else {
      message.error('复制失败，请手动选中链接复制')
    }
  }

  const revokeInvite = async () => {
    await http.delete(`/team/invites/${inviteInfo.id}`)
    message.success('邀请链接已作废')
    setInviteOpen(false)
  }

  // ── 成员角色 / 审批 / 移除 ────────────────────────────────────────
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

  const approveMember = async (m) => {
    setActionId(m.id)
    try {
      await http.post(`/team/members/${m.id}/approve`)
      message.success(`已通过「${m.displayName || m.username}」的加入申请`)
      loadMembers()
    } catch (err) {
      const e = err.response?.data?.error
      if (err.response?.status === 403 && e?.code === 'PLAN_LIMIT' && e?.reason === 'SEAT_LIMIT') {
        setSeatBlock(e.message)
      }
    } finally {
      setActionId(null)
    }
  }

  const rejectMember = async (m) => {
    setActionId(m.id)
    try {
      await http.post(`/team/members/${m.id}/reject`)
      message.success(`已拒绝「${m.displayName || m.username}」的加入申请`)
      loadMembers()
    } finally {
      setActionId(null)
    }
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
      render: (s) => {
        if (s === 'ACTIVE') return <Tag color="green" className={css.dotTag}>已激活</Tag>
        if (s === 'PENDING') return <Tag color="orange" className={css.dotTag}>待审批</Tag>
        return <Tag color="default">已停用</Tag>
      },
    },
    {
      title: '最近登录', dataIndex: 'lastLoginAt', width: 140,
      render: (v, m) => (
        <span className={css.muted}>
          {m.status === 'PENDING' ? '审批通过后可登录' : formatLogin(v)}
        </span>
      ),
    },
    {
      title: '操作', width: 170,
      render: (_, m) => {
        if (!isAdmin) return <span className={css.muted}>—</span>
        // 待审批行：只显示通过 / 拒绝
        if (m.status === 'PENDING') {
          return (
            <span className={css.rowActions}>
              <a onClick={() => approveMember(m)}>
                {actionId === m.id ? <Spin size="small" /> : '通过'}
              </a>
              <Popconfirm
                title={`拒绝「${m.displayName || m.username}」的加入申请？`}
                description="拒绝后该申请将被删除，对方可重新提交申请"
                okText="拒绝" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={() => rejectMember(m)}
              >
                <a className={css.danger}>拒绝</a>
              </Popconfirm>
            </span>
          )
        }
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
            当前 {data.members.length} 名成员
            {pendingMembers.length > 0 && ` · ${pendingMembers.length} 人待审批`}
            {seats === null ? '' : ` · 剩余 ${remain} 个可用席位`}
          </div>
        </div>
        <div className={css.toolbarRight}>
          <Button onClick={() => navigate('/billing')}>增购席位</Button>
          {isAdmin && (
            <Button type="primary" icon={<UserAddOutlined />} onClick={openInvite}>邀请成员</Button>
          )}
        </div>
      </div>

      {/* 待审批提醒条 */}
      {isAdmin && pendingMembers.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${pendingMembers.length} 位新成员等待审批`}
          description="新成员通过邀请链接注册后，需审批通过才能登录团队空间；新成员在审批通过前不占用席位。"
        />
      )}

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
          <div className={css.statTop}><LinkOutlined /> 链接邀请</div>
          <div className={css.roleSummary}>微信 / 飞书分享 · 注册后审批加入</div>
          <div className={css.statFoot}>
            邀请链接 7 天内有效，可多人注册；成员提交申请后由负责人审批
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
          rowClassName={(m) => (m.status === 'PENDING' ? css.pendingRow : '')}
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

      {/* 邀请成员：确认 → 微信/飞书分享 */}
      <Modal
        open={inviteOpen}
        title={inviteStep === 'confirm' ? '邀请成员加入团队' : '分享邀请链接'}
        footer={null}
        onCancel={() => setInviteOpen(false)}
        width={520}
        destroyOnClose
      >
        {inviteStep === 'confirm' ? (
          <div className={css.inviteConfirm}>
            <div className={css.inviteConfirmIcon}><UserAddOutlined /></div>
            <h3>生成团队邀请链接</h3>
            <p className={css.muted}>
              点击确定后生成专属邀请链接，你可以通过微信或飞书发给同事。
              同事打开链接自助注册，<b>角色固定为普通成员</b>，注册后需你审批通过才能登录团队空间。
            </p>
            <ul className={css.inviteConfirmList}>
              <li>链接有效期 7 天，可邀请多位同事</li>
              <li>新成员审批通过后才占用团队席位</li>
              <li>提交申请时你会收到邮件与站内通知</li>
            </ul>
            <div className={css.modalActions}>
              <Button onClick={() => setInviteOpen(false)}>取消</Button>
              <Button type="primary" loading={creating} onClick={confirmInvite}>确定邀请</Button>
            </div>
          </div>
        ) : (
          <div className={css.sharePanel}>
            <div className={css.shareChannelRow}>
              <button type="button" className={css.channelBtn} onClick={() => shareVia('wechat')}>
                <span className={`${css.channelIcon} ${css.wechatIcon}`} aria-hidden>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="#fff">
                    <path d="8.7 2.5C4.7 2.5 1.6 5.2 1.6 8.5c0 1.9 1 3.6 2.6 4.7l-.6 2.1 2.4-1.2c.8.2 1.5.3 2.7.3h.5c-.1-.4-.2-.9-.2-1.4 0-3.1 2.9-5.5 6.5-5.5h.4c-.6-2.8-3.6-5-7.2-5zM6.2 5.7c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9zm5 0c.5 0 .9.4.9.9s-.4.9-.9.9-.9-.4-.9-.9.4-.9.9-.9zM15.8 8.4c-3.2 0-5.8 2.2-5.8 4.9 0 2.7 2.6 4.9 5.8 4.9.7 0 1.3-.1 1.9-.3l2 1-.5-1.7c1.5-.9 2.4-2.3 2.4-3.9 0-2.7-2.6-4.9-5.8-4.9zm-2 3.9c.4 0 .8.3.8.8s-.4.8-.8.8-.8-.3-.8-.8.4-.8.8-.8zm4 0c.4 0 .8.3.8.8s-.4.8-.8.8-.8-.3-.8-.8.4-.8.8-.8z"/>
                  </svg>
                </span>
                <span>微信</span>
              </button>
              <button type="button" className={css.channelBtn} onClick={() => shareVia('feishu')}>
                <span className={`${css.channelIcon} ${css.feishuIcon}`} aria-hidden>飞</span>
                <span>飞书</span>
              </button>
              <button
                type="button"
                className={css.channelBtn}
                onClick={async () => {
                  const ok = await copyText(inviteInfo.url)
                  message.success(ok ? '邀请链接已复制' : '复制失败，请手动复制')
                }}
              >
                <span className={`${css.channelIcon} ${css.copyIcon}`}><LinkOutlined /></span>
                <span>复制链接</span>
              </button>
            </div>
            <div className={css.shareTip}>
              电脑端点击后浏览器会询问「是否打开飞书/微信」，选<b>打开</b>即唤起客户端，再 Ctrl+V 粘贴给同事
              （首次会询问，可勾选始终允许）；手机端弹出系统分享菜单，可直接选微信或飞书
            </div>

            <div className={css.qrBox}>
              <QrcodeOutlined className={css.qrCornerIcon} />
              <div className={css.qrImg}>
                <QRCodeSVG value={inviteInfo.url} size={148} level="M" />
              </div>
              <div className={css.qrHint}>同事用微信/飞书<b>扫一扫</b>也可打开邀请页</div>
            </div>

            <div className={css.shareUrl} title={inviteInfo.url}>{inviteInfo.url}</div>
            <div className={css.shareMeta}>
              有效期至 {new Date(inviteInfo.expiresAt).toLocaleDateString('zh-CN')} · 链接 7 天内可多人注册
            </div>
            <div className={css.shareFoot}>
              <Popconfirm
                title="作废此邀请链接？"
                description="作废后未注册的同事将无法通过该链接打开邀请页，已提交的申请不受影响"
                okText="作废链接" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={revokeInvite}
              >
                <a className={css.danger}>作废此链接</a>
              </Popconfirm>
              <Button type="primary" onClick={() => setInviteOpen(false)}>完成</Button>
            </div>
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
        <p className={css.muted}>增购席位后该成员才能通过审批；也可升级至企业版获得不限席位。</p>
        <div className={css.modalActions}>
          <Button onClick={() => setSeatBlock(null)}>稍后再说</Button>
          <Button type="primary" onClick={() => navigate('/billing')}>增购席位 ¥99/席/月</Button>
        </div>
      </Modal>
    </div>
  )
}
