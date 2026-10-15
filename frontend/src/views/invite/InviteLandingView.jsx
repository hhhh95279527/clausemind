// frontend/src/views/invite/InviteLandingView.jsx
// 团队邀请公开落地页 /invite/:token（无需登录）：
//   展示精美邀请卡片（团队名/邀请人/产品介绍）→ 受邀人填写注册信息
//   → POST /auth/register(persona=INVITE) 成为 PENDING 成员 → 等待管理员审批
//   审批结果通过邮件通知；未审批前无法登录。
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Button, Checkbox, Form, Input, Spin } from 'antd'
import {
  SafetyOutlined, UserOutlined, MailOutlined, LockOutlined,
  CheckCircleFilled, StopOutlined, ClockCircleOutlined, LoginOutlined,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import { useAuthStore } from '@/stores/auth.js'
import { trackSignUp } from '@/utils/analytics.js'
import css from './invite-landing.module.css'

// public 目录静态资源（同时作为微信/飞书链接预览的 og:image）
const OG_IMG = '/og-invite.jpg'

const USERNAME_RULES = [
  { required: true, message: '请设置用户名' },
  { pattern: /^[a-zA-Z0-9_]{3,20}$/, message: '3-20 位字母、数字或下划线' },
]
const PASSWORD_RULES = [
  { required: true, message: '请设置密码' },
  { min: 8, message: '密码至少 8 位，建议含字母与数字' },
]

const INVALID_TEXT = {
  NOT_FOUND: {
    icon: <StopOutlined className={`${css.stateIcon} ${css.err}`} />,
    title: '邀请链接无效',
    desc: '链接可能有误或团队空间状态异常，请联系团队管理员重新获取邀请链接。',
  },
  EXPIRED: {
    icon: <ClockCircleOutlined className={`${css.stateIcon} ${css.warn}`} />,
    title: '邀请链接已过期',
    desc: '邀请链接有效期为 7 天，请联系团队管理员重新生成链接后再注册。',
  },
  REVOKED: {
    icon: <StopOutlined className={`${css.stateIcon} ${css.err}`} />,
    title: '邀请链接已被作废',
    desc: '团队管理员已作废该邀请链接，请联系管理员重新邀请。',
  },
}

/** 设置/还原 OG 与 title（微信/飞书抓取链接预览使用） */
function useShareMeta(info) {
  useEffect(() => {
    if (!info) return
    const prevTitle = document.title
    const title = `${info.inviterName} 邀请你加入「${info.tenantName}」`
    const desc = '加入团队，一起使用 ClauseMind 智能合同审查：风险秒级识别、三角色审批流转、企业 Playbook 规则库。'
    document.title = title

    const upsert = (prop, key, content) => {
      let el = document.head.querySelector(`meta[${prop}="${key}"]`)
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute(prop, key)
        document.head.appendChild(el)
      }
      el.dataset.inviteMeta = '1'
      el.setAttribute('content', content)
    }
    const ogUrl = `${window.location.origin}${window.location.pathname}`
    upsert('property', 'og:title', title)
    upsert('property', 'og:description', desc)
    upsert('property', 'og:image', new URL(OG_IMG, window.location.origin).href)
    upsert('property', 'og:url', ogUrl)
    upsert('name', 'description', desc)

    return () => {
      document.title = prevTitle
      document.head.querySelectorAll('meta[data-invite-meta="1"]').forEach((el) => el.remove())
    }
  }, [info])
}

export default function InviteLandingView() {
  const { token } = useParams()
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const logout = useAuthStore((s) => s.logout)

  // loading | ready | invalid | done | loggedin
  const [phase, setPhase] = useState('loading')
  const [info, setInfo] = useState(null)
  const [reason, setReason] = useState('NOT_FOUND')
  const [doneTenant, setDoneTenant] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [form] = Form.useForm()

  useShareMeta(phase === 'ready' || phase === 'loggedin' ? info : null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const data = await http.get(`/public/invite/${token}`)
        if (cancelled) return
        if (!data.valid) {
          setInfo(data.tenantName ? { tenantName: data.tenantName } : null)
          setReason(data.reason || 'NOT_FOUND')
          setPhase('invalid')
          return
        }
        setInfo(data)
        setPhase(isAuthenticated ? 'loggedin' : 'ready')
      } catch {
        if (!cancelled) setPhase('invalid')
      }
    })()
    return () => { cancelled = true }
  }, [token, isAuthenticated])

  const submit = async (values) => {
    setSubmitting(true)
    try {
      const data = await http.post('/auth/register', {
        persona: 'INVITE',
        inviteToken: token,
        username: values.username,
        email: values.email,
        password: values.password,
        displayName: values.displayName || undefined,
      })
      if (data.pending) {
        setDoneTenant(data.tenantName || info?.tenantName || '团队')
        setPhase('done')
        trackSignUp('TEAM')
      }
    } catch {
      // 用户名/邮箱冲突等错误已由 http 拦截器统一 toast
    } finally {
      setSubmitting(false)
    }
  }

  const invalidState = INVALID_TEXT[reason] || INVALID_TEXT.NOT_FOUND

  return (
    <div className={css.page}>
      <div className={css.topbar}>
        <Link to="/" className={css.brand}>
          <span className={css.brandMark}><SafetyOutlined /></span>
          ClauseMind
        </Link>
        <Link to="/login">已有账号？登录</Link>
      </div>

      <div className={css.stage}>
        <div className={css.shell}>
          {phase === 'loading' && (
            <div className={css.centerBox}><Spin size="large" tip="正在打开邀请…" /></div>
          )}

          {phase === 'invalid' && (
            <div className={css.centerBox}>
              {invalidState.icon}
              <h2 className={css.stateTitle}>{invalidState.title}</h2>
              <p className={css.stateDesc}>{invalidState.desc}</p>
              <div className={css.stateActions}>
                <Button type="primary" onClick={() => navigate('/')}>返回首页</Button>
              </div>
            </div>
          )}

          {phase === 'loggedin' && (
            <div className={css.centerBox}>
              <LoginOutlined className={`${css.stateIcon} ${css.warn}`} />
              <h2 className={css.stateTitle}>你已登录 ClauseMind</h2>
              <p className={css.stateDesc}>
                邀请链接用于注册加入「{info?.tenantName || '团队'}」的新账号。
                如需接受邀请，请先退出当前登录，再完成注册。
              </p>
              <div className={css.stateActions}>
                <Button onClick={() => navigate('/')}>进入当前工作空间</Button>
                <Button type="primary" danger ghost onClick={() => { logout(); setPhase('ready') }}>
                  退出登录并注册
                </Button>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className={css.centerBox}>
              <CheckCircleFilled className={`${css.stateIcon} ${css.ok}`} />
              <h2 className={css.stateTitle}>申请已提交</h2>
              <p className={css.stateDesc}>
                你加入「<b>{doneTenant}</b>」的申请已发送给团队管理员。
                审批通过后会向你的注册邮箱发送通知邮件，届时即可登录团队空间。
              </p>
              <div className={css.stateActions}>
                <Button type="primary" onClick={() => navigate('/login')}>前往登录</Button>
              </div>
            </div>
          )}

          {phase === 'ready' && info && (
            <>
              {/* 左侧品牌视觉 */}
              <div className={css.hero}>
                <img className={css.heroImg} src={OG_IMG} alt="ClauseMind 团队协作" />
                <span className={css.heroKicker}><SafetyOutlined /> AI 智能合同审查</span>
                <h2 className={css.heroTitle}>让每一份合同<br />都经得起推敲</h2>
                <p className={css.heroDesc}>
                  ClauseMind 为团队提供合同上传、智能审查、风险确认与审批终审的一站式合规工作台。
                </p>
                <div className={css.heroFeats}>
                  <div className={css.heroFeat}><i>✓</i>风险点秒级识别，条款定位与法条依据直达</div>
                  <div className={css.heroFeat}><i>✓</i>成员上传 → 法务确认 → 负责人终审</div>
                  <div className={css.heroFeat}><i>✓</i>企业 Playbook 自定义规则与合同台账</div>
                </div>
              </div>

              {/* 右侧注册表单 */}
              <div className={css.formSide}>
                <div className={css.inviteBy}>
                  <b>{info.inviterName}</b> 邀请你加入
                </div>
                <h1 className={css.formTitle}>
                  {info.tenantName}
                  {info.planLabel && <span className={css.planTag}>{info.planLabel}</span>}
                </h1>
                <p className={css.formSub}>
                  完成注册后将以<b>普通成员</b>身份加入团队，管理员审批通过后即可登录。
                </p>

                <Form
                  form={form}
                  layout="vertical"
                  size="large"
                  autoComplete="off"
                  requiredMark={false}
                  initialValues={{ agreed: true }}
                  onFinish={submit}
                >
                  <Form.Item name="displayName" label="姓名 / 昵称">
                    <Input prefix={<UserOutlined />} placeholder="审批通知中展示的称呼，选填" maxLength={30} />
                  </Form.Item>
                  <Form.Item name="username" label="用户名" rules={USERNAME_RULES}>
                    <Input prefix={<UserOutlined />} placeholder="3-20 位字母、数字或下划线" maxLength={20} />
                  </Form.Item>
                  <Form.Item
                    name="email"
                    label="邮箱"
                    rules={[
                      { required: true, message: '请输入邮箱' },
                      { type: 'email', message: '邮箱格式不正确' },
                    ]}
                  >
                    <Input prefix={<MailOutlined />} placeholder="用于接收审批结果通知与验证码登录" />
                  </Form.Item>
                  <Form.Item name="password" label="设置密码" rules={PASSWORD_RULES}>
                    <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位，建议含字母与数字" />
                  </Form.Item>
                  <Form.Item
                    name="agreed"
                    valuePropName="checked"
                    rules={[{ validator: (_, v) => v ? Promise.resolve() : Promise.reject(new Error('请先阅读并同意协议')) }]}
                  >
                    <Checkbox className={css.agree}>
                      我已阅读并同意<a href="/terms" target="_blank" rel="noreferrer">《用户协议》</a>与
                      <a href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</a>
                    </Checkbox>
                  </Form.Item>
                  <Button
                    type="primary"
                    htmlType="submit"
                    loading={submitting}
                    block
                    className={css.submitBtn}
                  >
                    接受邀请并注册
                  </Button>
                </Form>

                <div className={css.footLinks}>
                  已有 ClauseMind 账号？<Link to="/login">直接登录</Link>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className={css.copyright}>
        © {new Date().getFullYear()} ClauseMind · 智能合同审查平台
      </div>
    </div>
  )
}
