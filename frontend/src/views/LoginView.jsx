// frontend/src/views/LoginView.jsx
// 登录页：密码登录 / 邮箱验证码双 tab；协议勾选；persona 驱动登录后跳转
import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Form, Input, Button, Checkbox, Tabs,
} from 'antd'
import { UserOutlined, LockOutlined, MailOutlined, SafetyOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import { useAppStore } from '@/stores/app.js'
import http from '@/utils/http.js'
import { trackLoginSuccess } from '@/utils/analytics.js'
import { homePath } from '@/utils/persona.js'
import { PLATFORM_TOKEN_KEY, PLATFORM_USER_KEY } from '@/utils/platformApi.js'
import styles from './auth/AuthPages.module.css'

export default function LoginView() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const toast = useAppStore((s) => s.toast)
  const [loading, setLoading] = useState(false)

  // 登录后跳转：按 workspaceType 分流（企业→/dashboard，个人→/home）
  const goHome = (user) => navigate(homePath(user), { replace: true })
  // 平台超管登录后跳转
  const goPlatform = (username) => {
    toast.success(`欢迎，平台管理员 ${username}`)
    navigate('/platform', { replace: true })
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}><SafetyOutlined /></span>
          ClauseMind
        </Link>
        <h1 className={styles.title}>登录 ClauseMind</h1>
        <p className={styles.subtitle}>签合同前，先让 AI 帮你排雷</p>

        <Tabs
          defaultActiveKey="pwd"
          centered
          items={[
            { key: 'pwd', label: '密码登录', children: <PwdLogin loading={loading} setLoading={setLoading} setAuth={setAuth} goHome={goHome} goPlatform={goPlatform} /> },
            { key: 'code', label: '邮箱验证码', children: <CodeLogin loading={loading} setLoading={setLoading} setAuth={setAuth} goHome={goHome} /> },
          ]}
        />

        <p style={{ textAlign: 'center', marginTop: 14, fontSize: 12.5 }}>
          <Link to="/">← 返回首页</Link>
        </p>
      </div>
    </div>
  )
}

// ── 协议勾选（两个 tab 共用；checked/onChange 由外层 Form.Item 自动注入）────
function Agreement() {
  return (
    <Checkbox className={styles.agree}>
      <span>
        我已阅读并同意<a href="/terms" target="_blank" rel="noreferrer">《用户协议》</a>与
        <a href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</a>
      </span>
    </Checkbox>
  )
}

// ── 登录表单公共尾部：协议勾选 + 提交按钮 + 辅助链接（两个 tab 共用）────────
function LoginFormFooter({ loading }) {
  return (
    <>
      <Form.Item name="agreed" valuePropName="checked" style={{ marginBottom: 12 }}>
        <Agreement />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large">
        登 录
      </Button>
      <div className={styles.links}>
        <Link to="/register">注册新账号</Link>
        <Link to="/forgot-password">忘记密码？</Link>
      </div>
    </>
  )
}

// ── 密码登录 ─────────────────────────────────────────────────────────────────
function PwdLogin({ loading, setLoading, setAuth, goHome, goPlatform }) {
  const [form] = Form.useForm()
  const toast = useAppStore((s) => s.toast)

  const handleLogin = async (values) => {
    if (!values.agreed) {
      toast.warning('请先阅读并同意用户协议与隐私政策')
      return
    }
    setLoading(true)
    try {
      // ① 先尝试租户用户登录（静默，不弹 toast）
      const data = await http.post('/auth/login', {
        username: values.username,
        password: values.password,
      }, { skipErrorToast: true })
      setAuth(data)
      trackLoginSuccess('password')
      toast.success('登录成功')
      goHome(data.user)
    } catch (err) {
      // ② 租户中「用户不存在」→ 尝试平台超管登录
      const status = err.response?.status
      const errMsg = err.response?.data?.error?.message || ''
      if (errMsg === '用户不存在') {
        try {
          const plat = await http.post('/platform/auth/login', {
            username: values.username,
            password: values.password,
          }, { skipErrorToast: true })
          localStorage.setItem(PLATFORM_TOKEN_KEY, plat.accessToken)
          localStorage.setItem(PLATFORM_USER_KEY, plat.username)
          goPlatform(plat.username)
          return
        } catch {
          // 平台登录也失败 → 统一提示
        }
        toast.error('账号或密码错误')
      } else if (errMsg && errMsg !== 'Unauthorized' && status !== 401 && status !== 403) {
        // 账号禁用等具体业务错误：透传展示
        toast.error(errMsg)
      } else if (status) {
        // 有响应但无明确信息（401/403 等）→ 统一归因为账密错误
        toast.error('账号或密码错误')
      } else {
        toast.error('登录失败，请检查网络后重试')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} onFinish={handleLogin} size="large" autoComplete="off" initialValues={{ agreed: true }}>
      <Form.Item name="username" rules={[{ required: true, message: '请输入用户名 / 邮箱' }]}>
        <Input prefix={<UserOutlined />} placeholder="请输入用户名 / 邮箱" />
      </Form.Item>
      <Form.Item name="password" rules={[
        { required: true, message: '请输入密码' },
        // 注册约束密码 ≥8 位：不足 8 位必然错误，点击登录即时拦截，不必等后端
        { min: 8, message: '密码至少 8 位，请检查是否输入有误' },
      ]}>
        <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" />
      </Form.Item>
      <LoginFormFooter loading={loading} />
    </Form>
  )
}

// ── 邮箱验证码登录 ─────────────────────────────────────────────────────────
function CodeLogin({ loading, setLoading, setAuth, goHome }) {
  const [form] = Form.useForm()
  const toast = useAppStore((s) => s.toast)
  const [cooldown, setCooldown] = useState(0)
  const timerRef = useRef(null)

  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current) }, [])

  const sendCode = async () => {
    try {
      await form.validateFields(['email'])
    } catch {
      return
    }
    const email = form.getFieldValue('email')
    try {
      await http.post('/auth/email-code', { email })
      toast.success('验证码已发送至邮箱，5 分钟内有效')
      setCooldown(60)
      timerRef.current = setInterval(() => {
        setCooldown((c) => {
          if (c <= 1) {
            clearInterval(timerRef.current)
            return 0
          }
          return c - 1
        })
      }, 1000)
    } catch {
      // 拦截器已提示（含 60 秒频控）
    }
  }

  const handleLogin = async (values) => {
    if (!values.agreed) {
      toast.warning('请先阅读并同意用户协议与隐私政策')
      return
    }
    setLoading(true)
    try {
      const data = await http.post('/auth/login-by-code', {
        email: values.email,
        code: values.code,
      })
      setAuth(data)
      trackLoginSuccess('email_code')
      toast.success('登录成功')
      goHome(data.user)
    } catch {
      // 拦截器已处理 toast
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} onFinish={handleLogin} size="large" autoComplete="off" initialValues={{ agreed: true }}>
      <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
        <Input prefix={<MailOutlined />} placeholder="请输入已绑定的邮箱地址" />
      </Form.Item>
      <Form.Item name="code" rules={[
        { required: true, message: '请输入验证码' },
        { pattern: /^\d{6}$/, message: '验证码为 6 位数字' },
      ]}>
        <Input
          prefix={<SafetyOutlined />}
          placeholder="6 位验证码"
          maxLength={6}
          addonAfter={
            <Button type="link" size="small" disabled={cooldown > 0} onClick={sendCode} style={{ padding: 0 }}>
              {cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
            </Button>
          }
        />
      </Form.Item>
      <LoginFormFooter loading={loading} />
      <div className={styles.tip}>
        使用注册时绑定的邮箱接收验证码即可登录；未注册的邮箱请先
        <Link to="/register">注册账号</Link>。
      </div>
    </Form>
  )
}
