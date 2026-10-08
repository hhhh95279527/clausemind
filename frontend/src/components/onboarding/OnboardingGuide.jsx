// frontend/src/components/onboarding/OnboardingGuide.jsx
// 首次登录 3 步欢迎引导（FR-3）：审一份合同 / 体验示例合同 / 看范本；可跳过。
// onboardingCompleted 由后端持久化；任意一步的主动作或跳过后即标记完成，不再弹出。
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Modal, Steps, Button, message } from 'antd'
import {
  FileAddOutlined, ExperimentOutlined, BookOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import http from '@/utils/http.js'

// 每步：标题、说明、主动作文案、跳转目标（按 persona 区分）
function buildSteps(persona) {
  const reviewPath = persona === 'TEAM' ? '/contracts' : '/new'
  const listPath = persona === 'TEAM' ? '/contracts' : '/my-contracts'
  return [
    {
      icon: <FileAddOutlined />,
      title: '审一份合同',
      desc: '上传或粘贴合同文本，30 秒获得风险清单、大白话摘要与整体评分。免费版每月 2 份。',
      cta: '去审一份合同',
      to: reviewPath,
    },
    {
      icon: <ExperimentOutlined />,
      title: '体验示例合同',
      desc: '不用准备文件：一键放入一份埋好风险点的示例劳动合同，走完整审查流程（每个空间仅可体验一次）。',
      cta: '放入示例合同',
      to: listPath,
      action: 'sample',
    },
    {
      icon: <BookOutlined />,
      title: '看看合同范本',
      desc: '劳动、租赁、劳务、NDA 标准范本库，签约前对照参考，避开高频坑点。',
      cta: '浏览合同范本',
      to: '/templates',
    },
  ]
}

export default function OnboardingGuide() {
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const navigate = useNavigate()

  const [open, setOpen] = useState(true)
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)

  if (!user || user.onboardingCompleted || !open) return null

  const steps = buildSteps(user.workspaceType)
  const step = steps[current]
  const isLast = current === steps.length - 1

  // 标记引导完成并关闭；返回后端更新后的 user（含 onboardingCompleted=true）
  const finish = async () => {
    try {
      const updated = await http.post('/auth/onboarding/complete')
      setUser(updated)
    } catch {
      // 即使接口失败也本地关闭，避免卡死；下次进入仍会引导
      setUser({ ...user, onboardingCompleted: true })
    }
    setOpen(false)
  }

  // 主动作：第 2 步先复制示例合同，再跳转；其余直接跳转
  const handleAction = async () => {
    if (step.action === 'sample') {
      setBusy(true)
      try {
        await http.post('/contracts/sample')
        message.success('示例合同已放入，解析完成后即可发起审查')
      } catch {
        // 409（已领过）等错误已由拦截器提示，仍继续引导完成
      } finally {
        setBusy(false)
      }
    }
    await finish()
    navigate(step.to)
  }

  return (
    <Modal
      title={`欢迎使用 ClauseMind，${user.displayName || user.username || ''}`}
      open
      width={560}
      maskClosable={false}
      closable={false}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Button type="link" danger onClick={finish} style={{ paddingLeft: 0 }}>跳过引导</Button>
          <div style={{ display: 'flex', gap: 8 }}>
            {current > 0 && <Button onClick={() => setCurrent((c) => c - 1)}>上一步</Button>}
            {!isLast && <Button onClick={() => setCurrent((c) => c + 1)}>下一步</Button>}
            <Button type="primary" loading={busy} onClick={handleAction}>
              {isLast ? '开始使用' : step.cta}
            </Button>
          </div>
        </div>
      }
    >
      <Steps
        current={current}
        size="small"
        style={{ margin: '8px 0 24px' }}
        items={steps.map((s) => ({ title: s.title, icon: s.icon }))}
      />
      <p style={{ fontSize: 15, fontWeight: 600, margin: '0 0 8px' }}>
        {current + 1}. {step.title}
      </p>
      <p style={{ color: 'var(--color-text-sub)', fontSize: 13.5, lineHeight: 1.8, margin: 0 }}>
        {step.desc}
      </p>
    </Modal>
  )
}
