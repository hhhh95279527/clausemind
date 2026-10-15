// frontend/src/views/feedback/FeedbackView.jsx
// 建议反馈页（个人版 / 企业版共用）：
// 用户填写建议类型 + 内容（+可选联系方式），POST /api/feedback，
// 后端落库并把建议以邮件发送到平台反馈邮箱。单用户每日限 5 条。
import { useState } from 'react'
import { Alert, Button, Card, Form, Input, Select } from 'antd'
import { BulbOutlined, MailOutlined } from '@ant-design/icons'
import http from '@/utils/http.js'
import { useAppStore } from '@/stores/app.js'
import css from './feedback.module.css'

const CATEGORY_OPTIONS = [
  { value: 'FEATURE', label: '功能建议' },
  { value: 'BUG', label: '问题反馈（Bug）' },
  { value: 'EXPERIENCE', label: '体验优化' },
  { value: 'OTHER', label: '其他' },
]

export default function FeedbackView() {
  const [form] = Form.useForm()
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const toast = useAppStore((s) => s.toast)

  const onFinish = async (values) => {
    setSubmitting(true)
    try {
      await http.post('/feedback', {
        category: values.category,
        content: values.content?.trim(),
        contact: values.contact?.trim() || '',
      })
      setDone(true)
      form.resetFields()
      toast.success('建议已提交，感谢你的反馈！')
    } catch {
      // 错误提示已由 http 拦截器统一 toast（如每日上限、内容过短）
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className={css.page}>
      <Card>
        <div className={css.intro}>
          <span className={css.introIcon}><BulbOutlined /></span>
          <div>
            <div className={css.introTitle}>提个建议</div>
            <div className={css.introDesc}>
              无论是新功能想法、遇到的问题，还是体验上的不顺手，都欢迎告诉我们。
              每一条建议都会直接发送到产品团队的邮箱。
            </div>
          </div>
        </div>
      </Card>

      <Card>
        {done ? (
          <Alert
            type="success"
            showIcon
            message="建议提交成功"
            description="我们已经收到你的建议并发送给产品团队，会认真阅读每一条反馈。"
            action={
              <Button size="small" type="primary" ghost onClick={() => setDone(false)}>
                再提一条
              </Button>
            }
          />
        ) : (
          <Form
            form={form}
            layout="vertical"
            initialValues={{ category: 'FEATURE' }}
            onFinish={onFinish}
            requiredMark={false}
          >
            <Form.Item
              name="category"
              label="建议类型"
              rules={[{ required: true, message: '请选择建议类型' }]}
            >
              <Select options={CATEGORY_OPTIONS} style={{ maxWidth: 260 }} />
            </Form.Item>

            <Form.Item
              name="content"
              label="建议内容"
              rules={[
                { required: true, message: '请填写建议内容' },
                { whitespace: true, message: '建议内容不能为空白' },
                { min: 5, message: '请至少写 5 个字，方便我们理解你的想法' },
                { max: 1000, message: '建议内容最多 1000 个字' },
              ]}
              extra="描述越具体越好：希望实现什么效果、在哪个页面操作、遇到了什么问题……"
            >
              <Input.TextArea
                rows={7}
                maxLength={1000}
                showCount
                placeholder="例如：希望合同审查结果支持按风险等级筛选，方便优先处理高风险条款。"
              />
            </Form.Item>

            <Form.Item
              name="contact"
              label="联系方式（选填）"
              rules={[{ max: 100, message: '联系方式最多 100 个字' }]}
              extra="如果希望我们就这条建议与你沟通，可以留下手机 / 邮箱 / 微信。"
            >
              <Input prefix={<MailOutlined />} placeholder="手机号 / 邮箱 / 微信" maxLength={100} style={{ maxWidth: 360 }} />
            </Form.Item>

            <div className={css.actions}>
              <Button type="primary" htmlType="submit" loading={submitting}>
                提交建议
              </Button>
            </div>
          </Form>
        )}
      </Card>

      <Card size="small">
        <div className={css.tips}>
          <b>温馨提示：</b>建议提交后会直接以邮件形式发送给产品团队；如需回复，请务必留下联系方式。
          每位用户每天最多提交 5 条建议。
        </div>
      </Card>
    </div>
  )
}
