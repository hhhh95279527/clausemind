// frontend/src/views/team/IntegrationsView.jsx
// 集成中心（对齐 docs/prototype/integrations.html）
// - 飞书：群机器人 Webhook（AES 加密存储、脱敏展示、真实测试卡片）+ MCP 指引
// - 其余 8 个集成：联系开通留资
// - 个人空间：加锁付费墙
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Button, Form, Input, Modal, Popconfirm, Spin, Tag, message,
} from 'antd'
import {
  LockOutlined, SafetyCertificateFilled,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import { useMeStore } from '@/stores/me.js'
import { useAuthStore } from '@/stores/auth.js'
import css from './integrations.module.css'

// 8 个「即将推出」集成（文案与原型一一对应）
const COMING_SOON = [
  { code: 'DINGTALK', logo: '钉', name: '钉钉', sub: '工作通知与审批', desc: '审查完成、到期提醒推送到钉钉群与工作通知，支持发起钉钉审批。' },
  { code: 'WECHAT_WORK', logo: '微', name: '企业微信', sub: '应用消息同步', desc: '通过企微应用推送审查卡片与台账提醒，客户 / 外部联系人场景适用。' },
  { code: 'ESIGN', logo: '签', name: '电子签', sub: '审查通过即发起签署', desc: '终审通过的合同一键发起电子签署，签署完成回写合同台账状态。' },
  { code: 'OA', logo: 'OA', name: 'OA 审批', sub: '对接企业现有审批流', desc: '审查意见书与用印申请联动 OA，按金额 / 部门走既有审批链路。' },
  { code: 'SSO', logo: 'S', name: 'SSO 单点登录', sub: '企业统一身份', desc: '支持 OIDC / SAML 对接企业 IdP，成员入职自动开通、离职自动回收。' },
  { code: 'OPEN_API', logo: '{ }', name: 'Open API', sub: '审查能力接入自有系统', desc: '提供合同上传、审查结果查询、台账同步 REST API 与 Webhook 回调。' },
  { code: 'WORD_PLUGIN', logo: 'W', name: 'Word 插件', sub: '在文档内直接审查', desc: '不离开 Word 即可发起审查、查看风险批注并一键采纳修改建议。' },
  { code: 'PRIVATE_DEPLOY', logo: '私', name: '私有化部署', sub: 'ENTERPRISE 专属', desc: '模型与数据部署在企业自有环境，审计存证、权限隔离与等标合规。' },
]

export default function IntegrationsView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const currentUser = useAuthStore((s) => s.user)
  const isTeamSpace = entitlement?.workspaceType === 'TEAM'
  const isAdmin = currentUser?.role === 'ADMIN'

  const [feishu, setFeishu] = useState(null)
  const [configOpen, setConfigOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [contact, setContact] = useState(null) // 当前留资集成
  const [contactDone, setContactDone] = useState(false)
  const [submittingLead, setSubmittingLead] = useState(false)
  const [leadForm] = Form.useForm()

  const loadFeishu = async () => {
    setFeishu(await http.get('/integrations/feishu'))
  }

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => {
    if (isTeamSpace) loadFeishu()
  }, [isTeamSpace])

  // ── 个人空间：加锁付费墙 ──
  if (entitlement && !isTeamSpace) {
    return (
      <div className={css.lockWrap}>
        <div className={css.lockCard}>
          <div className={css.lockIcon}><SafetyCertificateFilled /></div>
          <h3>集成中心为团队版 / 企业版权益</h3>
          <p className={css.lockMuted}>个人版（PERSONAL）不支持团队办公流集成</p>
          <ul className={css.lockFeats}>
            <li><span className={css.tick}>✓</span>飞书群机器人推送审查完成、合同到期与额度预警</li>
            <li><span className={css.tick}>✓</span>钉钉 / 企业微信 / 电子签等 8 项集成联系开通</li>
            <li><span className={css.tick}>✓</span>集成凭证加密存储、脱敏展示</li>
          </ul>
          <Button type="primary" size="large" block onClick={() => navigate('/pricing')}>了解团队版 TEAM</Button>
        </div>
      </div>
    )
  }

  if (!feishu) {
    return <div className={css.center}><Spin size="large" tip="加载集成信息…" /></div>
  }

  const openConfig = () => {
    setWebhookUrl('')
    setConfigOpen(true)
  }

  const saveWebhook = async () => {
    if (!/^https:\/\//.test(webhookUrl.trim())) {
      message.warning('请以 https:// 开头填写飞书群机器人 Webhook')
      return
    }
    setSaving(true)
    try {
      const res = await http.put('/integrations/feishu', { webhookUrl: webhookUrl.trim() })
      setFeishu((f) => ({ ...f, configured: true, webhookMask: res.webhookMask }))
      setWebhookUrl('')
      message.success('Webhook 已加密保存')
      loadFeishu()
    } catch (err) {
      message.error(err.response?.data?.error?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    try {
      await http.post('/integrations/feishu/test', {}, { skipErrorToast: true })
      message.success('测试卡片已发送，请查看飞书群')
      loadFeishu()
    } catch (err) {
      message.error(err.response?.data?.error?.message || '测试通知发送失败，请检查 Webhook 是否有效')
    } finally {
      setTesting(false)
    }
  }

  const removeWebhook = async () => {
    await http.delete('/integrations/feishu')
    message.success('已移除飞书配置')
    setFeishu({ configured: false, webhookMask: null, lastTestAt: null })
  }

  const openContact = (item) => {
    setContact(item)
    setContactDone(false)
    leadForm.resetFields()
    leadForm.setFieldsValue({ name: currentUser?.displayName || currentUser?.username || '' })
  }

  const submitLead = async () => {
    const values = await leadForm.validateFields()
    setSubmittingLead(true)
    try {
      await http.post('/integrations/leads', { integration: contact.code, ...values })
      setContactDone(true)
    } catch (err) {
      message.error(err.response?.data?.error?.message || '提交失败，请稍后重试')
    } finally {
      setSubmittingLead(false)
    }
  }

  return (
    <div className={css.page}>
      <div className={css.grid}>
        {/* 飞书（已上线） */}
        <div className={`${css.card} ${css.cardLive}`}>
          <div className={css.cardHead}>
            <span className={css.logoLive}>飞</span>
            <div>
              <b className={css.cardName}>飞书</b>
              <div className={css.muted}>群机器人 + MCP Agent</div>
            </div>
            {feishu.configured
              ? <Tag color="green" className={css.mlAuto}>已配置</Tag>
              : <Tag className={css.mlAuto}>未配置</Tag>}
          </div>
          <div className={css.feat}>
            <Tag color={feishu.configured ? 'green' : 'default'}>
              {feishu.configured ? '可用' : '未配置'}
            </Tag>
            <div>
              <b>群机器人通知</b><br />
              <span className={css.muted}>审查完成、合同到期 digest、额度 80% 自动推送</span>
            </div>
          </div>
          <div className={css.feat}>
            <Tag>未配置</Tag>
            <div>
              <b>MCP Agent 工具</b><br />
              <span className={css.muted}>发送审查结果卡片、同步合同多维表记录</span>
            </div>
          </div>
          <div className={css.actions}>
            <Button type="primary" size="small" onClick={openConfig}>配置</Button>
            <Button size="small" onClick={() => openContact({ code: 'FEISHU_SUPPORT', name: '飞书' })}>问题反馈</Button>
          </div>
        </div>

        {/* 8 个即将推出 */}
        {COMING_SOON.map((item) => (
          <div key={item.code} className={css.card}>
            <div className={css.cardHead}>
              <span className={css.logo}>{item.logo}</span>
              <div>
                <b className={css.cardName}>{item.name}</b>
                <div className={css.muted}>{item.sub}</div>
              </div>
              <Tag className={css.mlAuto}>即将推出</Tag>
            </div>
            <div className={css.feat}>
              <div><span className={css.muted}>{item.desc}</span></div>
            </div>
            <div className={css.actions}>
              <Button size="small" onClick={() => openContact(item)}>联系开通</Button>
            </div>
          </div>
        ))}
      </div>

      {/* 安全小灰条 */}
      <div className={css.secureBar}>
        <LockOutlined className={css.secureIcon} />
        <div>所有集成凭证均加密存储、脱敏展示；通知与数据仅向你显式配置的官方域名发送，WorkMind 不会向第三方共享合同内容。</div>
      </div>

      {/* 飞书配置 */}
      <Modal
        open={configOpen}
        title="配置飞书集成"
        width={560}
        footer={null}
        onCancel={() => setConfigOpen(false)}
        destroyOnClose
      >
        <div className={css.cfgHead}>
          <span className={css.logoLive}>飞</span>
          <b>群机器人通知</b>
          <Tag color={feishu.configured ? 'green' : 'default'} className={css.mlAuto}>
            {feishu.configured ? '可用' : '未配置'}
          </Tag>
        </div>

        {feishu.configured && (
          <Alert
            type="success" showIcon className={css.cfgAlert}
            message={<>当前 Webhook：<span className={css.maskText}>{feishu.webhookMask}</span></>}
            description={
              <span className={css.muted}>
                页面仅脱敏展示{feishu.lastTestAt ? `；最近测试：${new Date(feishu.lastTestAt).toLocaleString('zh-CN', { hour12: false })}` : '；尚未发送测试通知'}
              </span>
            }
          />
        )}

        {isAdmin ? (
          <>
            <div className={css.fieldLabel}>Webhook URL</div>
            <Input.TextArea
              rows={2}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx"
              className={css.webhookInput}
            />
            <div className={css.hint}>在飞书群「设置 → 群机器人 → 添加自定义机器人」获取；仅支持 open.feishu.cn / feishu.cn / larksuite.com 官方域名，保存后加密存储。</div>
            <div className={css.cfgBtns}>
              <Button type="primary" size="small" loading={saving} onClick={saveWebhook}>保存 Webhook</Button>
              <Button size="small" loading={testing} disabled={!feishu.configured} onClick={sendTest}>发送测试通知</Button>
              {feishu.configured && (
                <Popconfirm
                  title="移除飞书 Webhook 配置？"
                  okText="移除" cancelText="取消" okButtonProps={{ danger: true }}
                  onConfirm={removeWebhook}
                >
                  <Button size="small" danger type="text">移除配置</Button>
                </Popconfirm>
              )}
            </div>
          </>
        ) : (
          <Alert type="info" showIcon message="仅团队负责人可修改 Webhook 配置，你可以联系负责人完成配置。" className={css.cfgAlert} />
        )}

        <div className={css.divider} />

        <div className={css.cfgHead}>
          <span className={css.logoMcp}>MCP</span>
          <b>MCP Agent 工具</b>
          <Tag className={css.mlAuto}>未配置</Tag>
        </div>
        <Alert
          type="info" showIcon className={css.cfgAlert}
          message="需要飞书自建应用的 App ID / App Secret，由管理员在服务端配置（.env）。配置后 Agent 将获得两个工具：发送审查结果卡片、同步多维表记录。"
        />
        <div className={css.cfgBtns}>
          <Button size="small" onClick={() => { setConfigOpen(false); setGuideOpen(true) }}>查看配置指引</Button>
        </div>
      </Modal>

      {/* MCP 配置指引 */}
      <Modal
        open={guideOpen}
        title="MCP Agent 配置指引（飞书自建应用）"
        footer={<Button type="primary" onClick={() => { setGuideOpen(false); setConfigOpen(true) }}>返回飞书配置</Button>}
        onCancel={() => setGuideOpen(false)}
        destroyOnClose
      >
        <ol className={css.steps}>
          <li>
            <b>创建企业自建应用</b>
            <div className={css.muted}>在飞书开放平台（open.feishu.cn）的企业管理后台创建一个企业自建应用，获取应用的 App ID 与 App Secret。</div>
          </li>
          <li>
            <b>开通机器人能力与权限</b>
            <div className={css.muted}>为应用开通机器人能力，并开通发送消息、读写多维表（Bitable）相关权限，发布应用版本并由管理员审批通过。</div>
          </li>
          <li>
            <b>在服务端填入凭证</b>
            <div className={css.muted}>由管理员将 App ID / App Secret 写入服务端环境变量（.env）并重启服务，Agent 自动获得「发送审查结果卡片」「同步多维表记录」两个工具。</div>
          </li>
        </ol>
      </Modal>

      {/* 联系开通留资 */}
      <Modal
        open={!!contact}
        title={contactDone ? null : `联系开通 · ${contact?.name || ''}`}
        footer={null}
        onCancel={() => setContact(null)}
        destroyOnClose
      >
        {!contactDone ? (
          <>
            <Form form={leadForm} layout="vertical">
              <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请填写姓名' }, { max: 100 }]}>
                <Input placeholder="如：王芳" maxLength={100} />
              </Form.Item>
              <Form.Item
                name="phone" label="联系电话"
                rules={[
                  { required: true, message: '请填写联系电话' },
                  { pattern: /^[0-9+\-\s]{6,20}$/, message: '手机号格式不正确' },
                ]}
              >
                <Input placeholder="请输入手机号，顾问将与您电话沟通" />
              </Form.Item>
              <Form.Item name="note" label="需求备注" rules={[{ max: 500, message: '最多 500 字' }]}>
                <Input.TextArea rows={3} maxLength={500} showCount placeholder={`如：希望开通${contact?.name || '该'}集成，团队 20 人，主要需要到期提醒推送`} />
              </Form.Item>
            </Form>
            <div className={css.modalActions}>
              <Button onClick={() => setContact(null)}>取消</Button>
              <Button type="primary" loading={submittingLead} onClick={submitLead}>提交</Button>
            </div>
          </>
        ) : (
          <div className={css.leadDone}>
            <div className={css.doneIcon}>✓</div>
            <h3>提交成功</h3>
            <p className={css.muted}>销售将在 1 个工作日内联系您，请保持电话畅通。</p>
            <Button type="primary" block onClick={() => setContact(null)}>我知道了</Button>
          </div>
        )}
      </Modal>
    </div>
  )
}
