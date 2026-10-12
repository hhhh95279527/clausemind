// frontend/src/views/RegisterView.jsx
// 注册分流页：先选身份（我是个人 / 我们是企业），再走对应表单；用户名+密码即可注册，
// 邮箱用于绑定后接收验证码登录（注册时不强制验证码）；支持落地页 CTA hash 直达
import { useState } from 'react'
import { useNavigate, Link, useLocation } from 'react-router-dom'
import { Form, Input, Button, Select, Checkbox, message } from 'antd'
import {
  MailOutlined, LockOutlined, SafetyOutlined, UserOutlined,
  TeamOutlined, BankOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import http from '@/utils/http.js'
import { trackSignUp } from '@/utils/analytics.js'
import { homePath } from '@/utils/persona.js'
import styles from './auth/AuthPages.module.css'

const COMPANY_SIZES = ['1-10 人', '11-50 人', '51-200 人', '200 人以上']
const POSITIONS = ['HR', '行政', '法务', '负责人', '其他']

export default function RegisterView() {
  // step: 'choose' | 'PERSONAL' | 'TEAM'；落地页 CTA 用 hash 直达对应表单
  const location = useLocation()
  const initialStep = location.hash === '#form-personal'
    ? 'PERSONAL'
    : location.hash === '#form-team'
      ? 'TEAM'
      : 'choose'
  const [step, setStep] = useState(initialStep)

  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} ${styles.cardWide}`}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandMark}><SafetyOutlined /></span>
          ClauseMind
        </Link>
        <h1 className={styles.title}>注册 ClauseMind</h1>
        <p className={styles.subtitle}>先选择使用身份，两类空间随时可以升级</p>

        {step === 'choose' && (
          <div className={styles.choice}>
            <button type="button" className={styles.choiceCard} onClick={() => setStep('PERSONAL')}>
              <span className={styles.choiceIco}><UserOutlined /></span>
              <span className={styles.choiceBody}>
                <b>我是个人</b>
                <p>30 秒开通，免企业信息。每月 2 份免费审查，风险点、大白话摘要与评分注册即看。</p>
              </span>
              <span className={styles.choiceGo}>›</span>
            </button>
            <button type="button" className={styles.choiceCard} onClick={() => setStep('TEAM')}>
              <span className={styles.choiceIco}><TeamOutlined /></span>
              <span className={styles.choiceBody}>
                <b>我们是企业</b>
                <p>创建团队空间，支持多人协作、审批流转、企业 Playbook 自定义审查规则与合同台账。</p>
              </span>
              <span className={styles.choiceGo}>›</span>
            </button>
          </div>
        )}

        {step === 'PERSONAL' && <PersonalForm onBack={() => setStep('choose')} />}
        {step === 'TEAM' && <TeamForm onBack={() => setStep('choose')} />}

        <p className={styles.foot}>已有账号？<Link to="/login">返回登录</Link></p>
      </div>
    </div>
  )
}

// ── 用户名规则（前后端保持一致：3-20 位字母、数字、下划线）──────────────────
const USERNAME_RULES = [
  { required: true, message: '请设置用户名' },
  { pattern: /^[a-zA-Z0-9_]{3,20}$/, message: '3-20 位字母、数字或下划线' },
]

// ── 协议勾选 ────────────────────────────────────────────────────────────────
function Agreement() {
  return (
    <Form.Item name="agreed" valuePropName="checked" style={{ marginBottom: 8 }}
      rules={[{ validator: (_, v) => v ? Promise.resolve() : Promise.reject(new Error('请先阅读并同意协议')) }]}>
      <Checkbox className={styles.agree}>
        <span>
          我已阅读并同意<a href="/terms" target="_blank" rel="noreferrer">《用户协议》</a>与
          <a href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</a>
        </span>
      </Checkbox>
    </Form.Item>
  )
}

// ── 个人注册表单 ───────────────────────────────────────────────────────────
function PersonalForm({ onBack }) {
  const [form] = Form.useForm()
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [loading, setLoading] = useState(false)

  const submit = async (values) => {
    setLoading(true)
    try {
      const data = await http.post('/auth/register', {
        persona: 'PERSONAL',
        username: values.username,
        email: values.email,
        password: values.password,
        displayName: values.displayName || undefined,
      })
      setAuth(data)
      message.success('开通成功')
      trackSignUp('PERSONAL')
      navigate(homePath(data.user), { replace: true })
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <a className={styles.back} onClick={onBack} href="#back">← 重新选择身份</a>
      <h3 style={{ fontSize: 15, marginBottom: 14 }}>开通个人免费空间</h3>
      <Form form={form} onFinish={submit} size="large" autoComplete="off"
        layout="horizontal" labelCol={{ flex: '74px' }} colon={false}
        initialValues={{ agreed: true }}>
        <Form.Item name="username" label="用户名" rules={USERNAME_RULES}>
          <Input prefix={<UserOutlined />} placeholder="3-20 位字母、数字或下划线" />
        </Form.Item>
        <Form.Item name="email" label="邮箱" rules={[
          { required: true, message: '请输入邮箱' },
          { type: 'email', message: '邮箱格式不正确' },
        ]}>
          <Input prefix={<MailOutlined />} placeholder="绑定后可用邮箱验证码登录" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[
          { required: true, message: '请设置密码' },
          { min: 8, message: '密码至少 8 位，建议含字母与数字' },
        ]}>
          <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位，建议含字母与数字" />
        </Form.Item>
        <Form.Item name="displayName" label="昵称">
          <Input prefix={<UserOutlined />} placeholder="选填，审查意见书中的称呼" />
        </Form.Item>
        <Agreement />
        <Button type="primary" htmlType="submit" loading={loading} block size="large">
          免费开通
        </Button>
        <p style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
          开通即享 FREE 免费版：每月 2 份 · 3000 字以内 · 记录保留 7 天
        </p>
      </Form>
    </div>
  )
}

// ── 企业注册表单 ───────────────────────────────────────────────────────────
function TeamForm({ onBack }) {
  const [form] = Form.useForm()
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)
  const [loading, setLoading] = useState(false)

  const submit = async (values) => {
    setLoading(true)
    try {
      const data = await http.post('/auth/register', {
        persona: 'TEAM',
        username: values.username,
        email: values.email,
        password: values.password,
        orgName: values.orgName,
        companySize: values.companySize,
        position: values.position,
      })
      setAuth(data)
      message.success('团队空间已创建')
      trackSignUp('TEAM')
      navigate(homePath(data.user), { replace: true })
    } catch {
      // 拦截器已提示
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <a className={styles.back} onClick={onBack} href="#back">← 重新选择身份</a>
      <h3 style={{ fontSize: 15, marginBottom: 14 }}>创建企业团队空间</h3>
      <Form form={form} onFinish={submit} size="large" autoComplete="off"
        layout="horizontal" labelCol={{ flex: '92px' }} colon={false}
        initialValues={{ agreed: true, companySize: COMPANY_SIZES[0], position: POSITIONS[0] }}>
        <Form.Item name="orgName" label="企业名称" rules={[{ required: true, message: '请填写企业名称' }]}>
          <Input prefix={<BankOutlined />} placeholder="例如：杭州星辰科技有限公司" />
        </Form.Item>
        <Form.Item name="companySize" label="企业规模">
          <Select options={COMPANY_SIZES.map((v) => ({ value: v, label: v }))} />
        </Form.Item>
        <Form.Item name="position" label="你的岗位">
          <Select options={POSITIONS.map((v) => ({ value: v, label: v }))} />
        </Form.Item>
        <Form.Item name="username" label="管理员账号" rules={USERNAME_RULES}>
          <Input prefix={<UserOutlined />} placeholder="3-20 位字母、数字或下划线" />
        </Form.Item>
        <Form.Item name="email" label="工作邮箱" rules={[
          { required: true, message: '请输入工作邮箱' },
          { type: 'email', message: '邮箱格式不正确' },
        ]}>
          <Input prefix={<MailOutlined />} placeholder="绑定后可用邮箱验证码登录" />
        </Form.Item>
        <Form.Item name="password" label="密码" rules={[
          { required: true, message: '请设置密码' },
          { min: 8, message: '密码至少 8 位，建议含字母与数字' },
        ]}>
          <Input.Password prefix={<LockOutlined />} placeholder="至少 8 位，建议含字母与数字" />
        </Form.Item>
        <Agreement />
        <Button type="primary" htmlType="submit" loading={loading} block size="large">
          创建团队空间
        </Button>
        <p style={{ textAlign: 'center', marginTop: 10, fontSize: 12, color: 'var(--color-text-muted)' }}>
          团队空间默认含 TEAM 团队版演示席位：5 席位 · 企业 Playbook · 审批流转
        </p>
      </Form>
    </div>
  )
}
