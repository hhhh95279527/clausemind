// frontend/src/views/public/LandingView.jsx
// 落地页（FR-1 / AC-1 / AC-16）：双 CTA 分流 + 免费价值前置 + 场景 + 能力 + 双曲线 + 定价预览
// 文案唯一来源 docs/prototype/index.html；已登录访问按 persona 跳转（AC-1）
import { Link, Navigate } from 'react-router-dom'
import {
  ClockCircleOutlined, MessageOutlined, CheckCircleFilled,
  FileTextOutlined, HomeOutlined, SolutionOutlined, LockOutlined,
  SafetyCertificateOutlined, EditOutlined, CameraOutlined, CalendarOutlined,
  UserOutlined, BankOutlined, TagOutlined,
} from '@ant-design/icons'
import { useAuthStore } from '@/stores/auth.js'
import { homePath } from '@/utils/persona.js'
import PublicChrome from './PublicChrome.jsx'
import styles from './LandingView.module.css'

const FREE_CARDS = [
  {
    icon: <CheckCircleFilled />,
    title: '完整风险清单与命中条款',
    desc: '逐条列出高 / 中 / 低风险，每条风险都定位到合同原文，不错杀、不漏掉。',
  },
  {
    icon: <MessageOutlined />,
    title: '大白话合同摘要',
    desc: '用人人都懂的话讲清楚这份合同让你承担什么、放弃什么、风险在哪，不需要法律背景。',
  },
  {
    icon: <ClockCircleOutlined />,
    title: '整体风险评分',
    desc: '综合风险数量与严重程度给出评分与建议结论：可以签、谨慎签，还是先改再签。',
  },
]

const SCENES = [
  { icon: <FileTextOutlined />, title: '劳动合同', desc: '试用期、违约金、社保、竞业限制，入职前先过一遍。' },
  { icon: <HomeOutlined />, title: '房屋租赁', desc: '押金、维修责任、提前退租、涨租条款，租房不吃哑巴亏。' },
  { icon: <SolutionOutlined />, title: '兼职劳务', desc: '劳务报酬、结算周期、工伤责任，接私活也要看明白。' },
  { icon: <LockOutlined />, title: '保密与竞业 NDA', desc: '保密范围、补偿金、竞业期限，签字前搞清代价。' },
]

const ABILITIES = [
  {
    icon: <SafetyCertificateOutlined />,
    title: '双轨审查 + 人工终审',
    desc: '规则引擎确定性保底，AI 语义审查发现隐藏风险，结果合并去重，采纳与否由你最终拍板。',
  },
  {
    icon: <EditOutlined />,
    title: 'AI 多轮改稿与红划线',
    desc: '针对每条风险多轮对话让 AI 修改措辞，改动处以红划线呈现，新旧条款逐条对比。',
  },
  {
    icon: <CameraOutlined />,
    title: '拍照 OCR 审查',
    desc: '纸质合同拍张照，OCR 自动转录文字，直接进入同一条审查管线，免费版同样可用。',
  },
  {
    icon: <CalendarOutlined />,
    title: '合同台账到期提醒',
    desc: '合同期限、试用期、续签节点统一管理，临期合同自动倒计时预警，不再靠脑子记。',
  },
]

const REPORT_ROWS = [
  {
    level: '高风险', tagCls: 'tagRed',
    title: '违约金比例过高',
    plain: '大白话：违约金写了 3 个月工资，但法律只在培训服务期、竞业限制两种情况下认这笔钱，这条大概率无效，却很容易先把人吓住。',
  },
  {
    level: '中风险', tagCls: 'tagOrange',
    title: '试用期超过法定上限',
    plain: '大白话：合同只签 1 年却约定 3 个月试用期，按法律最多只能约定 2 个月，多出来的月份可以要工资差额。',
  },
  {
    level: '低风险', tagCls: 'tagBlue',
    title: '管辖约定不明确',
    plain: '大白话：没写清楚将来在哪个法院打官司，万一扯皮可能要跑外地，费时费钱，建议补一句本地法院管辖。',
  },
]

const PRICE_CARDS = [
  { code: 'FREE', name: 'FREE', price: '¥0', priceSmall: '', desc: '每月 2 份 · 3000 字以内 · 四类合同 · 风险点 + 摘要 + 评分 · 记录保留 7 天', cta: '免费开始' },
  { code: 'PERSONAL', name: 'PERSONAL', price: '¥19', priceSmall: '/月', desc: '或 ¥99/年（省 48%）· 不限份数与长度 · 深度报告 · 多轮改稿 · 永久存档', cta: '查看个人版' },
  { code: 'TEAM', name: 'TEAM', price: '¥99', priceSmall: '/席/月', desc: '5 席位 · 企业 Playbook · 审批流转 · 不限台账 · 飞书通知', cta: '查看团队版' },
  { code: 'ENTERPRISE', name: 'ENTERPRISE', price: '定制', priceSmall: '', desc: '不限席位 · 行业专项包 · SSO / 私有化 / API · 审计存证 · 专属客户成功', cta: '联系我们' },
]

export default function LandingView() {
  const user = useAuthStore((s) => s.user)
  // AC-1：已登录访问 / 按 persona 跳转，落地页只对未登录访客渲染
  if (user) return <Navigate to={homePath(user)} replace />

  return (
    <PublicChrome>
      {/* Hero */}
      <header className={styles.hero}>
        <span className={styles.heroBadge}>
          <ClockCircleOutlined style={{ fontSize: 14 }} />
          AI 合同风险审查 · 免费看到风险
        </span>
        <h1 className={styles.heroTitle}>
          签合同前，先让 AI 帮你<span className={styles.hl}>排雷</span>
        </h1>
        <p className={styles.heroSub}>
          个人签入职、租房、兼职合同，企业管团队审批与合同台账——上传合同，30 秒输出风险清单、大白话摘要与整体评分，看清楚再签字。
        </p>
        <div className={styles.heroCta}>
          <Link className={`${styles.btn} ${styles.btnPrimary} ${styles.btnLg}`} to="/register#form-personal">
            我是个人，免费审合同
          </Link>
          <Link className={`${styles.btn} ${styles.btnGhost} ${styles.btnLg}`} to="/register#form-team">
            为团队开通企业版
          </Link>
        </div>
        <p className={styles.heroMicro}>免费版每月 2 份 · 注册即看风险点与评分 · 无需信用卡</p>

        <div className={styles.reportCard}>
          <div className={styles.reportHead}>
            <span className={`${styles.tag} ${styles.tagRed}`}>高风险 1</span>
            <span className={`${styles.tag} ${styles.tagOrange}`}>中风险 1</span>
            <span className={`${styles.tag} ${styles.tagBlue}`}>低风险 1</span>
            <span className={styles.reportHeadHint}>《合同风险审查意见书》摘要 · 示例</span>
          </div>
          <div className={styles.reportBody}>
            {REPORT_ROWS.map((r) => (
              <div key={r.title} className={styles.reportRow}>
                <span className={`${styles.tag} ${styles[r.tagCls]}`}>{r.level}</span>
                <div>
                  <b>{r.title}</b>
                  <div className={styles.reportPlain}>{r.plain}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </header>

      {/* 免费就能看到什么 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>免费就能看到什么</h2>
        <p className={styles.sectionSub}>不用先付费、不用绑卡，注册后第一份合同就能拿到这些</p>
        <div className={styles.grid3}>
          {FREE_CARDS.map((c) => (
            <div key={c.title} className={styles.cardFlat}>
              <div className={styles.cardIcon}>{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.desc}</p>
            </div>
          ))}
        </div>
        <p className={styles.freeNote}>深度修改建议、法条依据、替代措辞、Word 导出与永久存档为付费权益。</p>
      </section>

      {/* 场景入口 */}
      <section className={`${styles.section} ${styles.sectionTight}`}>
        <h2 className={styles.sectionTitle}>你手上是哪种合同？</h2>
        <p className={styles.sectionSub}>免费版覆盖四类高频合同，上传即审</p>
        <div className={styles.grid4}>
          {SCENES.map((s) => (
            <Link key={s.title} to="/register" className={`${styles.cardFlat} ${styles.sceneCard}`}>
              <div className={styles.cardIcon}>{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
              <span className={styles.sceneMore}>免费审查 →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* 核心能力 */}
      <section className={styles.bandSection}>
        <div className={styles.bandInner}>
          <h2 className={styles.sectionTitle}>四项核心能力，覆盖审签全流程</h2>
          <p className={styles.sectionSub}>不是通用问答机器人，每个模块都对应一个真实的合同任务</p>
          <div className={styles.grid4}>
            {ABILITIES.map((a) => (
              <div key={a.title} className={styles.cardFlat}>
                <div className={styles.cardIcon}>{a.icon}</div>
                <h3>{a.title}</h3>
                <p>{a.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 双曲线对比 */}
      <section className={`${styles.section} ${styles.trackSec}`}>
        <div className={styles.trackInner}>
          <h2 className={styles.sectionTitle}>个人与企业，各走各的曲线</h2>
          <p className={styles.sectionSub}>同一套审查引擎，按使用场景选择身份，随时可升级</p>
          <div className={styles.trackGrid}>
            <div className={styles.trackCard}>
              <div className={styles.trackHead}>
                <span className={styles.trackIcon}><UserOutlined /></span>
                <b>个人</b>
              </div>
              <p>适合偶尔签合同的个人：入职劳动合同、租房、兼职劳务、NDA，先看懂风险再落笔。</p>
              <ul>
                <li><span className={styles.tick}>✓</span>低频合同，按月开通，不用长期订阅</li>
                <li><span className={styles.tick}>✓</span>大白话解读风险，不需要法律背景</li>
                <li><span className={styles.tick}>✓</span>免费版每月 2 份，风险点与评分直接看</li>
                <li><span className={styles.tick}>✓</span>不订阅也能买 ¥9.9 深度审查券，逐份解锁</li>
              </ul>
              <div className={styles.trackPrice}>¥19<span>/月起 · 年付 ¥99</span></div>
              <div className={styles.trackActions}>
                <Link className={`${styles.btn} ${styles.btnPrimary}`} to="/register#form-personal">我是个人，免费开始</Link>
                <Link className={`${styles.btn} ${styles.btnGhost}`} to="/pricing">查看个人版</Link>
              </div>
            </div>

            <div className={`${styles.trackCard} ${styles.trackCardEnt}`}>
              <div className={styles.trackHead}>
                <span className={styles.trackIcon}><BankOutlined /></span>
                <b>企业 / 团队</b>
              </div>
              <p>适合 HR、法务与业务团队：把企业自己的审查标准固化成规则，多人协作、审批留痕。</p>
              <ul>
                <li><span className={styles.tick}>✓</span>企业 Playbook：自定义审查规则与禁用表述</li>
                <li><span className={styles.tick}>✓</span>团队席位、三角色权限与审批流转</li>
                <li><span className={styles.tick}>✓</span>合同台账不限条数，到期合规提醒</li>
                <li><span className={styles.tick}>✓</span>飞书通知、系统集成与私有化（企业版）</li>
              </ul>
              <div className={styles.trackPrice}>¥99<span>/席/月起 · 企业版定制</span></div>
              <div className={styles.trackActions}>
                <Link className={`${styles.btn} ${styles.btnPrimary}`} to="/register#form-team">创建团队空间</Link>
                <Link className={`${styles.btn} ${styles.btnGhost}`} to="/pricing">查看团队 / 企业方案</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 定价预览 */}
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>四档套餐，免费就能起步</h2>
        <p className={styles.sectionSub}>从 ¥0 到企业定制，按身份和用量选择，随时升级</p>
        <div className={styles.priceGrid}>
          {PRICE_CARDS.map((p) => (
            <div key={p.code} className={styles.priceCard}>
              <div className={styles.priceName}>{p.name}</div>
              <div className={styles.pricePrice}>
                {p.price}{p.priceSmall && <small>{p.priceSmall}</small>}
              </div>
              <div className={styles.priceDesc}>{p.desc}</div>
              <Link className={`${styles.btn} ${styles.btnGhost} ${styles.btnBlock} ${styles.btnSm}`} to="/pricing">{p.cta}</Link>
            </div>
          ))}
        </div>
        <div className={styles.coupon}>
          <span className={styles.couponIcon}><TagOutlined /></span>
          <div>
            <b>深度审查券 ¥9.9/份</b>
            <p>不订阅也能逐份解锁：1 券解锁 1 份完整深度审查（含长文档），免费用户也可购买。</p>
          </div>
          <Link className={`${styles.btn} ${styles.btnPrimary}`} to="/pricing">了解券包</Link>
        </div>
      </section>

      {/* 结尾 CTA */}
      <section className={`${styles.section} ${styles.sectionTight}`}>
        <div className={styles.ctaBand}>
          <h2>下一份合同签字之前，先排个雷</h2>
          <p>免费版每月 2 份，注册即看风险点、大白话摘要与整体评分，无需信用卡</p>
          <div className={styles.heroCta}>
            <Link className={`${styles.btn} ${styles.btnBandPrimary} ${styles.btnLg}`} to="/register#form-personal">
              我是个人，免费审合同
            </Link>
            <Link className={`${styles.btn} ${styles.btnBandGhost} ${styles.btnLg}`} to="/register#form-team">
              为团队开通企业版
            </Link>
          </div>
        </div>
      </section>
    </PublicChrome>
  )
}
