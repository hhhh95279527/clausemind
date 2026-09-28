// frontend/src/views/public/PricingView.jsx
// 定价页（FR-2）：四档套餐 + 月付/年付纯前端切换 + 深度审查券 + 权益对比表 + FAQ + 企业留资弹窗
// 文案唯一来源 docs/prototype/pricing.html
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal, Form, Input, message } from 'antd'
import { TagOutlined } from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import { homePath } from '@/utils/persona.js'
import PublicChrome from './PublicChrome.jsx'
import styles from './PricingView.module.css'

const PLAN_FREE_FEATS = [
  '每月 2 份审查额度',
  '单份 3000 字以内',
  '劳动 / 租赁 / 劳务 / NDA 四类合同',
  '风险点 + 大白话摘要 + 风险评分',
  '水印版摘要 PDF',
  '审查记录保留 7 天',
  '拍照 OCR 识别',
]

const PLAN_PERSONAL_FEATS = [
  '不限审查份数、长文档与非标合同',
  '深度报告：法条依据 + 修改建议 + 替代措辞',
  'AI 多轮改稿，红划线对比',
  'Word / PDF / 条款对比导出',
  '永久存档 + 个人条款库 + 审查偏好',
  '拍照 OCR 识别',
]

const PLAN_TEAM_FEATS = [
  '包含个人版全部能力',
  '企业 Playbook 自定义审查规则',
  '5 席位，管理员 / 审查员 / 只读三角色',
  '合同台账不限条数',
  '审批流转与意见留痕',
  '飞书消息通知',
]

const PLAN_ENT_FEATS = [
  '不限席位与审查额度',
  '行业专项规则包',
  '审计日志与存证报告',
  'SSO / 私有化 / API / 系统集成',
  '专属客户成功经理',
]

// 权益明细对比：行 = 权益，列 = FREE/PERSONAL/TEAM/ENTERPRISE；'yes' 显示 ✓，'no' 显示 ✕，字符串直接展示
const COMPARE_ROWS = [
  { name: '月度额度', cells: ['每月 2 份', '不限份数', '不限份数（按席位）', '不限席位与额度'] },
  { name: '合同类型', cells: ['劳动 / 租赁 / 劳务 / NDA', '不限，含非标与长文档', '不限，含非标与长文档', '不限，含行业专项包'] },
  { name: '风险点与摘要评分', cells: ['yes', 'yes', 'yes', 'yes'] },
  { name: '法条依据 / 修改建议 / 替代措辞', cells: ['no', 'yes', 'yes', 'yes'] },
  { name: 'AI 多轮改稿', cells: ['no', 'yes', 'yes', 'yes'] },
  { name: '导出', cells: ['水印摘要 PDF', 'Word / PDF / 条款对比', 'Word / PDF / 条款对比', 'Word / PDF / 条款对比'] },
  { name: '存档', cells: ['记录保留 7 天', '永久存档 + 个人条款库', '团队永久存档', '团队永久存档 + 存证报告'] },
  { name: '企业 Playbook 自定义规则', cells: ['no', 'no', 'yes', 'yes'] },
  { name: '团队协作与审批', cells: ['no', 'no', '5 席位 / 三角色 / 审批流', '不限席位 / 三角色 / 审批流'] },
  { name: '飞书通知 / 系统集成', cells: ['no', 'no', '飞书通知', 'SSO / API / 私有化 / 集成'] },
  { name: '安全合规', cells: ['租户隔离 + 加密存储', '租户隔离 + 加密存储', '租户隔离 + 加密存储', '审计日志 + 存证'] },
]

const FAQS = [
  {
    q: '免费版真的能看到风险吗？',
    a: '能。免费版每月 2 份（3000 字以内，限劳动 / 租赁 / 劳务 / NDA 四类），完整风险清单、大白话摘要与整体评分都免费可见；只有深度修改建议、法条依据、替代措辞、Word 导出与永久存档属于付费权益，也可以用 ¥9.9 深度审查券逐份解锁。',
  },
  {
    q: '可以随时取消吗？',
    a: '可以。个人版与团队版均为订阅制，可随时关闭自动续费，到期后降为免费版，已生成的审查记录在订阅期内可正常查看；演示环境中的支付与套餐切换均为模拟操作，不产生真实交易。',
  },
  {
    q: '合同数据会被用于训练吗？',
    a: '不会。你上传的合同正文仅用于完成本次审查，不会被用于模型训练；埋点仅采集事件与属性元数据，不包含合同正文。详见《隐私政策》。',
  },
]

function Cell({ v }) {
  if (v === 'yes') return <span className={styles.tick}>✓</span>
  if (v === 'no') return <span className={styles.cross}>✕</span>
  return <span>{v}</span>
}

export default function PricingView() {
  const [period, setPeriod] = useState('monthly') // monthly | yearly
  const [contactOpen, setContactOpen] = useState(false)
  const [contactForm] = Form.useForm()
  const user = useAuthStore((s) => s.user)

  // 已登录：CTA 先进控制台（Phase 5 收银台上线后改为对应套餐页）；未登录去注册
  const personalHref = user ? homePath(user) : '/register#form-personal'
  const teamHref = user ? homePath(user) : '/register#form-team'
  const freeHref = user ? homePath(user) : '/register'

  const submitContact = () => {
    // 演示环境：静态留资，不产生真实工单（原型明示）
    setContactOpen(false)
    contactForm.resetFields()
    message.success('需求已记录（演示环境，不产生真实工单）')
  }

  return (
    <PublicChrome>
      <section className={styles.section}>
        <h1 className={styles.title}>个人免费起步，团队按席订阅</h1>
        <p className={styles.sub}>
          免费版即可看到风险点、大白话摘要与评分；深度建议、导出与存档按需升级，也可以用 ¥9.9 审查券逐份解锁
        </p>

        <div className={styles.segWrap}>
          <div className={styles.segmented}>
            <button
              type="button"
              className={period === 'monthly' ? styles.segOn : ''}
              onClick={() => setPeriod('monthly')}
            >月付</button>
            <button
              type="button"
              className={period === 'yearly' ? styles.segOn : ''}
              onClick={() => setPeriod('yearly')}
            >年付</button>
          </div>
        </div>

        <div className={styles.grid}>
          {/* 免费 */}
          <div className={styles.planCard}>
            <div className={styles.planName}>FREE 免费版</div>
            <p className={styles.planDesc}>个人低频使用，先看清风险再签字</p>
            <div className={styles.planPrice}>¥0<small> /月</small></div>
            <ul className={styles.planFeats}>
              {PLAN_FREE_FEATS.map((f) => <li key={f}><span className={styles.tick}>✓</span>{f}</li>)}
            </ul>
            <Link className={`${styles.btn} ${styles.btnGhost} ${styles.btnBlock}`} to={freeHref}>免费开始</Link>
          </div>

          {/* 个人版 */}
          <div className={`${styles.planCard} ${styles.featured}`}>
            <span className={styles.planFlag}>最受欢迎</span>
            <div className={styles.planName}>PERSONAL 个人版</div>
            <p className={styles.planDesc}>不限份数的深度审查与改稿，个人长期使用</p>
            <div className={styles.planPrice}>
              {period === 'monthly' ? (
                <span>¥19<small> /月</small></span>
              ) : (
                <span>¥99<small> /年</small><span className={styles.saveTag}>省 48%</span></span>
              )}
            </div>
            <ul className={styles.planFeats}>
              {PLAN_PERSONAL_FEATS.map((f) => <li key={f}><span className={styles.tick}>✓</span>{f}</li>)}
            </ul>
            <Link className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`} to={personalHref}>开通个人版</Link>
          </div>

          {/* 团队版 */}
          <div className={styles.planCard}>
            <div className={styles.planName}>TEAM 团队版</div>
            <p className={styles.planDesc}>HR / 法务团队多人协作，规则统一、审批留痕</p>
            <div className={styles.planPrice}>¥99<small> /席/月</small></div>
            <ul className={styles.planFeats}>
              {PLAN_TEAM_FEATS.map((f) => <li key={f}><span className={styles.tick}>✓</span>{f}</li>)}
            </ul>
            <Link className={`${styles.btn} ${styles.btnPrimary} ${styles.btnBlock}`} to={teamHref}>为团队开通</Link>
          </div>

          {/* 企业版 */}
          <div className={styles.planCard}>
            <div className={styles.planName}>ENTERPRISE 企业版</div>
            <p className={styles.planDesc}>规模化组织，安全合规与系统集成需求</p>
            <div className={`${styles.planPrice} ${styles.planPriceCustom}`}>定制</div>
            <ul className={styles.planFeats}>
              {PLAN_ENT_FEATS.map((f) => <li key={f}><span className={styles.tick}>✓</span>{f}</li>)}
            </ul>
            <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnBlock}`} onClick={() => setContactOpen(true)}>
              联系我们
            </button>
          </div>
        </div>
      </section>

      {/* 深度审查券 */}
      <section className={styles.sectionTight}>
        <div className={styles.coupon}>
          <span className={styles.couponIcon}><TagOutlined /></span>
          <div>
            <b>深度审查券 ¥9.9/份</b>
            <p>1 券解锁 1 份完整深度审查（含法条依据、修改建议、替代措辞，支持长文档）；免费用户也可购买，不用订阅。</p>
          </div>
          <Link className={`${styles.btn} ${styles.btnPrimary}`} to={freeHref}>购买券包</Link>
        </div>
      </section>

      {/* 权益对比表 */}
      <section className={styles.sectionTight}>
        <h2 className={styles.h2}>权益明细对比</h2>
        <p className={styles.tableSub}>所有方案均包含租户隔离与加密存储；合同内容不用于模型训练</p>
        <div className={styles.tableWrap}>
          <table className={styles.compareTable}>
            <thead>
              <tr>
                <th>权益</th><th>FREE</th><th>PERSONAL</th><th>TEAM</th><th>ENTERPRISE</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.name}>
                  <td className={styles.rowName}>{row.name}</td>
                  {row.cells.map((v, i) => <td key={i}><Cell v={v} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section className={styles.sectionTight}>
        <h2 className={styles.h2}>常见问题</h2>
        <div className={styles.faqList}>
          {FAQS.map((f) => (
            <div key={f.q} className={styles.faqPanel}>
              <h3>{f.q}</h3>
              <p>{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 联系企业顾问 */}
      <section className={styles.contactSec}>
        <h2 className={styles.contactTitle}>还有疑问？</h2>
        <p className={styles.contactSub}>企业版支持定制演示与规则试运行，留下需求我们会联系你。</p>
        <button type="button" className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} onClick={() => setContactOpen(true)}>
          联系企业顾问
        </button>
      </section>

      <Modal
        title="联系企业顾问"
        open={contactOpen}
        onCancel={() => setContactOpen(false)}
        onOk={submitContact}
        okText="提交需求"
        cancelText="取消"
      >
        <Form form={contactForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="name" label="姓名" rules={[{ required: true, message: '请输入您的姓名' }]}>
            <Input placeholder="请输入您的姓名" />
          </Form.Item>
          <Form.Item name="phone" label="电话" rules={[{ required: true, message: '请输入手机号或座机' }]}>
            <Input placeholder="请输入手机号或座机" />
          </Form.Item>
          <Form.Item name="demand" label="需求">
            <Input.TextArea rows={3} placeholder="团队规模、关注的合同类型、是否需要私有化 / 集成等" />
          </Form.Item>
          <p className={styles.formNote}>演示环境：提交仅为静态展示，不产生真实工单。</p>
        </Form>
      </Modal>
    </PublicChrome>
  )
}
