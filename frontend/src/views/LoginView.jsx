// frontend/src/views/LoginView.jsx
// 登录页：密码登录 / 邮箱验证码双 tab；协议勾选；persona 驱动登录后跳转
import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import {
  Form, Input, Button, Checkbox, Tabs, message,
} from 'antd'
import { UserOutlined, LockOutlined, MailOutlined, SafetyOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import http from '@/utils/http.js'
import { homePath } from '@/utils/persona.js'
import styles from './auth/AuthPages.module.css'

export default function LoginView() {
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [loading, setLoading] = useState(false)

  // 登录后跳转：按 workspaceType 分流（企业→/dashboard，个人→/home）
  const goHome = (user) => navigate(homePath(user), { replace: true })

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
            { key: 'pwd', label: '密码登录', children: <PwdLogin loading={loading} setLoading={setLoading} setAuth={setAuth} goHome={goHome} /> },
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

// ── 协议勾选（两个 tab 共用）────────────────────────────────────────────────
// 注意：外层 Form.Item 设了 valuePropName="checked"，antd 注入的属性名是 checked
// （不是默认的 value），这里必须接收 checked，否则勾选状态无法回显。
function Agreement({ checked, onChange }) {
  return (
    <Checkbox
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={styles.agree}
    >
      <span>
        我已阅读并同意<a href="/terms" target="_blank" rel="noreferrer">《用户协议》</a>与
        <a href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</a>
      </span>
    </Checkbox>
  )
}

// ── 密码登录 ─────────────────────────────────────────────────────────────────
function PwdLogin({ loading, setLoading, setAuth, goHome }) {
  const [form] = Form.useForm()

  const handleLogin = async (values) => {
    if (!values.agreed) {
      message.warning('请先阅读并同意用户协议与隐私政策')
      return
    }
    setLoading(true)
    try {
      const data = await http.post('/auth/login', {
        username: values.username,
        password: values.password,
      })
      setAuth(data)
      message.success('登录成功')
      goHome(data.user)
    } catch {
      // http 拦截器已处理 toast
    } finally {
      setLoading(false)
    }
  }

  return (
    <Form form={form} onFinish={handleLogin} size="large" autoComplete="off" initialValues={{ agreed: true }}>
      <Form.Item name="username" rules={[{ required: true, message: '请输入用户名 / 邮箱' }]}>
        <Input prefix={<UserOutlined />} placeholder="请输入用户名 / 邮箱" />
      </Form.Item>
      <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" />
      </Form.Item>
      <Form.Item name="agreed" valuePropName="checked" style={{ marginBottom: 12 }}>
        <Agreement />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large">
        登 录
      </Button>
      <div className={styles.links}>
        <Link to="/register">注册新账号</Link>
        <span className={styles.muted}>忘记密码？（即将上线）</span>
      </div>
      <div className={styles.demo}>
        演示账号：<br />
        企业演示 <code>testboss / Test1234</code><br />
        个人演示 <code>demo_personal / Test1234</code>
      </div>
    </Form>
  )
}

// ── 邮箱验证码登录 ─────────────────────────────────────────────────────────
function CodeLogin({ loading, setLoading, setAuth, goHome }) {
  const [form] = Form.useForm()
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
      message.success('验证码已发送（演示环境见后端控制台，或使用固定码 123456）')
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
      message.warning('请先阅读并同意用户协议与隐私政策')
      return
    }
    setLoading(true)
    try {
      const data = await http.post('/auth/login-by-code', {
        email: values.email,
        code: values.code,
      })
      setAuth(data)
      message.success('登录成功')
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
        <Input prefix={<MailOutlined />} placeholder="请输入邮箱地址" />
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
      <Form.Item name="agreed" valuePropName="checked" style={{ marginBottom: 12 }}>
        <Agreement />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large">
        登录 / 注册
      </Button>
      <div className={styles.links}>
        <Link to="/register">注册新账号</Link>
        <span className={styles.muted}>忘记密码？（即将上线）</span>
      </div>
      <div className={styles.tip}>
        演示环境验证码输出在后端控制台，或使用固定码 <b>123456</b>；未注册邮箱验证通过后将自动开通免费个人空间（每月 2 份免费审查）。
      </div>
    </Form>
  )
}
