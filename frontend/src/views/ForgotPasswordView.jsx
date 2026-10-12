// frontend/src/views/ForgotPasswordView.jsx
// 忘记密码 / 重置密码（邮件链接模式）：
// - /forgot-password：输入绑定邮箱 → 后端发一次性重置链接（15 分钟有效）
// - /reset-password?token=xxx：设置新密码 → 成功后跳登录
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Form, Input, Button, message, Result } from 'antd'
import { SafetyOutlined, MailOutlined, LockOutlined, CheckCircleFilled } from '@ant-design/icons'
import http from '@/utils/http.js'
import styles from './auth/AuthPages.module.css'

// ── 第一步：申请重置链接 ─────────────────────────────────────────
function ForgotForm() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [sentTo, setSentTo] = useState(null)

  const submit = async (values) => {
    setLoading(true)
    try {
      await http.post('/auth/forgot-password', { email: values.email })
      setSentTo(values.email)
    } catch {
      // 拦截器已 toast（未绑定邮箱 / 60 秒频控）
    } finally {
      setLoading(false)
    }
  }

  if (sentTo) {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <CheckCircleFilled style={{ fontSize: 44, color: 'var(--color-success, #16a34a)' }} />
        <h2 style={{ margin: '14px 0 8px', fontSize: 18 }}>重置链接已发送</h2>
        <p style={{ color: 'var(--color-text-sub)', fontSize: 13, lineHeight: 1.8 }}>
          已发送至 <b>{sentTo}</b>，请查收邮件并在 15 分钟内完成重置。<br />
          没收到？检查一下垃圾箱，或稍后再试。
        </p>
        <Button type="primary" block size="large" style={{ marginTop: 16 }} onClick={() => navigate('/login')}>
          返回登录
        </Button>
        <Button type="link" block style={{ marginTop: 4 }} onClick={() => setSentTo(null)}>
          重新发送
        </Button>
      </div>
    )
  }

  return (
    <Form onFinish={submit} size="large" autoComplete="off">
      <p style={{ color: 'var(--color-text-sub)', fontSize: 13, marginBottom: 18 }}>
        输入注册时绑定的邮箱，我们会发送一条密码重置链接。
      </p>
      <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
        <Input prefix={<MailOutlined />} placeholder="请输入绑定的邮箱地址" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large">
        发送重置链接
      </Button>
      <div className={styles.links}>
        <Link to="/login">返回登录</Link>
        <Link to="/register">注册新账号</Link>
      </div>
    </Form>
  )
}

// ── 第二步：邮件链接落地，设置新密码 ─────────────────────────────
function ResetForm() {
  const [sp] = useSearchParams()
  const navigate = useNavigate()
  const token = sp.get('token') || ''
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)

  const submit = async (values) => {
    setLoading(true)
    try {
      await http.post('/auth/reset-password', { token, newPassword: values.password })
      message.success('密码已重置，请使用新密码登录')
      setDone(true)
    } catch {
      // 拦截器已 toast（链接失效 / 密码过短）
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <Result
        status="warning"
        title="链接无效"
        subTitle="重置链接缺少凭据，请从邮件中的链接进入，或重新申请。"
        extra={<Button type="primary" onClick={() => navigate('/forgot-password')}>重新申请</Button>}
      />
    )
  }

  if (done) {
    return (
      <div style={{ textAlign: 'center', padding: '8px 0' }}>
        <CheckCircleFilled style={{ fontSize: 44, color: 'var(--color-success, #16a34a)' }} />
        <h2 style={{ margin: '14px 0 8px', fontSize: 18 }}>密码已重置</h2>
        <p style={{ color: 'var(--color-text-sub)', fontSize: 13 }}>
          旧登录状态已全部失效，请使用新密码重新登录。
        </p>
        <Button type="primary" block size="large" style={{ marginTop: 16 }} onClick={() => navigate('/login')}>
          去登录
        </Button>
      </div>
    )
  }

  return (
    <Form onFinish={submit} size="large" autoComplete="off">
      <p style={{ color: 'var(--color-text-sub)', fontSize: 13, marginBottom: 18 }}>
        请设置新密码（至少 8 位）。重置成功后，所有已登录设备将强制下线。
      </p>
      <Form.Item name="password" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '密码至少 8 位' }]}>
        <Input.Password prefix={<LockOutlined />} placeholder="新密码（至少 8 位）" />
      </Form.Item>
      <Form.Item
        name="confirm"
        dependencies={['password']}
        rules={[
          { required: true, message: '请再次输入新密码' },
          ({ getFieldValue }) => ({
            validator(_, value) {
              if (!value || getFieldValue('password') === value) return Promise.resolve()
              return Promise.reject(new Error('两次输入的密码不一致'))
            },
          }),
        ]}
      >
        <Input.Password prefix={<LockOutlined />} placeholder="确认新密码" />
      </Form.Item>
      <Button type="primary" htmlType="submit" loading={loading} block size="large">
        重置密码
      </Button>
      <div className={styles.links}>
        <Link to="/login">返回登录</Link>
      </div>
    </Form>
  )
}

export default function ForgotPasswordView() {
  const [sp] = useSearchParams()
  const isReset = sp.get('token') !== null

  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}><SafetyOutlined /></span>
          ClauseMind
        </Link>
        <h1 className={styles.title}>{isReset ? '设置新密码' : '忘记密码'}</h1>
        <p className={styles.subtitle}>{isReset ? '凭邮件链接完成密码重置' : '通过绑定邮箱找回密码'}</p>
        {isReset ? <ResetForm /> : <ForgotForm />}
      </div>
    </div>
  )
}
