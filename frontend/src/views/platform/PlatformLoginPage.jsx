// frontend/src/views/platform/PlatformLoginPage.jsx
// 平台超管登录页：独立于主站登录体系（platform_admins 账号），不进主导航
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, message } from 'antd'
import { SafetyCertificateOutlined } from '@ant-design/icons'
import platformApi, { PLATFORM_TOKEN_KEY, PLATFORM_USER_KEY, platformErrMessage } from '@/utils/platformApi.js'

export default function PlatformLoginPage() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  const doLogin = async (v) => {
    setLoading(true)
    try {
      const data = await platformApi.post('/auth/login', { username: v.username, password: v.password })
      localStorage.setItem(PLATFORM_TOKEN_KEY, data.accessToken)
      localStorage.setItem(PLATFORM_USER_KEY, data.username)
      message.success(`欢迎，平台管理员 ${data.username}`)
      navigate('/platform', { replace: true })
    } catch (err) {
      message.error(platformErrMessage(err, '登录失败'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #0f1117 0%, #1e1b4b 100%)',
    }}>
      <div style={{
        width: 380, padding: '36px 32px', borderRadius: 12,
        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
        backdropFilter: 'blur(8px)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <SafetyCertificateOutlined style={{ fontSize: 42, color: '#818cf8' }} />
          <h1 style={{ color: '#e5e7eb', fontSize: 20, margin: '12px 0 4px' }}>ClauseMind 平台管理</h1>
          <p style={{ color: '#9ca3af', fontSize: 13, margin: 0 }}>跨租户超级管理员专用入口</p>
        </div>
        <Form layout="vertical" onFinish={doLogin}>
          <Form.Item name="username" rules={[{ required: true, message: '请输入账号' }]}>
            <Input size="large" placeholder="平台管理员账号" autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            登录平台控制台
          </Button>
        </Form>
      </div>
    </div>
  )
}
