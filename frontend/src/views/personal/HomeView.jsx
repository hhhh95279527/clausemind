// frontend/src/views/personal/HomeView.jsx
// 个人工作台：欢迎语 / 额度卡两态 / 四类场景入口 / 最近审查 / 避坑指南
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ThunderboltOutlined, CheckOutlined, HomeOutlined, ClockCircleOutlined,
  SafetyCertificateOutlined, QuestionCircleOutlined, CalendarOutlined, FileTextOutlined,
} from '@ant-design/icons'
import { useMeStore } from '@/stores/me.js'
import { useContractStore } from '@/stores/contract.js'
import { useAuthStore } from '@/stores/auth.js'
import { FREE_LIMITS } from '@/config/plans.js'
import { SCENE_ANCHORS, sceneLabel, fmtDate, daysUntil, riskCountOf } from './scene.js'
import styles from './personal.module.css'

const SCENE_CARDS = [
  { code: 'LABOR', icon: <SafetyCertificateOutlined />, title: '劳动合同', desc: '新 offer 要签了？试用期、社保、竞业限制一眼看清。' },
  { code: 'LEASE', icon: <HomeOutlined />, title: '房屋租赁', desc: '租房签约前查押金、维修义务和提前退租违约金。' },
  { code: 'SERVICE', icon: <ClockCircleOutlined />, title: '兼职劳务', desc: '咖啡厅、家教、接单兼职：报酬、工伤与扣款写明白。' },
  { code: 'NDA', icon: <FileTextOutlined />, title: '保密与 NDA', desc: '入职背调、合作前签 NDA：保密范围与违约责任别踩坑。' },
]

const GUIDES = [
  { title: '定金与订金的区别', desc: '一字之差，违约时能不能双倍返还，结果完全不同。', min: '阅读 2 分钟 →' },
  { title: '试用期最长能约定多久', desc: '合同签 1 年和签 3 年，试用期上限差了 4 个月。', min: '阅读 3 分钟 →' },
  { title: '兼职协议也要写明这 3 点', desc: '报酬结算、安全责任、随时解除：口头约定最容易扯皮。', min: '阅读 2 分钟 →' },
]

export default function HomeView() {
  const navigate = useNavigate()
  const user = useAuthStore((s) => s.user)
  const { entitlement, loadEntitlement } = useMeStore()
  const { contracts, loadingList, loadContracts, copySample } = useContractStore()

  useEffect(() => {
    loadEntitlement()
    loadContracts()
  }, [])

  const name = user?.displayName || user?.username || '你'
  const deep = !!entitlement?.features?.deep
  const quota = entitlement?.monthlyReviewQuota ?? FREE_LIMITS.monthlyReviews
  const used = entitlement?.usedReviews ?? 0
  const quotaPct = Math.min(100, Math.round((used / Math.max(1, quota)) * 100))
  const recent = contracts.slice(0, 5)

  const trySample = async () => {
    const c = await copySample()
    // 等待解析完成由结果页自行轮询
    navigate(`/review/${c.id}`)
  }

  return (
    <div className={styles.wrap}>
      {/* 欢迎区 */}
      <div className={styles.welcome}>
        <h1>你好，{name}</h1>
        <p>租房、入职、兼职、签 NDA 之前，把合同丢给 WorkMind，先帮你把坑标出来。</p>
      </div>

      {/* 额度卡 */}
      <div className={`${styles.panel} ${styles.quotaBanner}`} style={{ padding: '18px 20px' }}>
        {!deep ? (
          <>
            <div className={styles.quotaLeft}>
              <h3>
                <ThunderboltOutlined style={{ color: 'var(--color-primary)' }} />
                本月免费额度 <span style={{ color: 'var(--color-primary)' }}>{used} / {quota}</span> 份
              </h3>
              <div className={styles.progress}><i style={{ width: `${quotaPct}%` }} /></div>
              <div className={`${styles.small} ${styles.muted}`} style={{ marginTop: 8 }}>
                每月 {quota} 份免费审查 · 单份 ≤ {FREE_LIMITS.maxChars} 字 · 记录保留 {FREE_LIMITS.retentionDays} 天；升级个人版后不限份数，长合同也能审。
              </div>
            </div>
            <div className={styles.quotaRight}>
              <button className="btn btn-ghost" onClick={() => navigate('/pricing')}>查看全部权益</button>
              <button className="btn btn-primary" onClick={() => navigate('/new')}>审查一份合同</button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.quotaLeft} style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <div className={styles.paidBadge}><CheckOutlined style={{ fontSize: 20 }} /></div>
              <div style={{ flex: 1 }}>
                <h3 style={{ marginBottom: 2 }}>
                  个人版{entitlement?.planExpiresAt ? `有效期至 ${fmtDate(entitlement.planExpiresAt)}` : ''} · 不限份数
                </h3>
                <div className={styles.progress} style={{ maxWidth: 320 }}>
                  <i style={{ width: '100%', background: 'var(--color-success)' }} />
                </div>
                <div className={`${styles.small} ${styles.muted}`} style={{ marginTop: 8 }}>
                  AI 改稿、Word 红划线、永久存档、个人条款库已全部解锁，长文档也可放心上传。
                </div>
              </div>
            </div>
            <div className={styles.quotaRight}>
              <button className="btn btn-primary" onClick={() => navigate('/new')}>审查一份合同</button>
            </div>
          </>
        )}
      </div>

      {/* 场景四卡 */}
      <div className={styles.grid4}>
        {SCENE_CARDS.map((c) => (
          <a key={c.code} className={styles.cardFlat} onClick={() => navigate(`/new#${SCENE_ANCHORS[c.code]}`)}>
            <span className={styles.ci} style={{ fontSize: 20 }}>{c.icon}</span>
            <h3>{c.title}</h3>
            <p>{c.desc}</p>
          </a>
        ))}
      </div>

      {/* 最近审查 */}
      <div className={styles.panel}>
        <div className={styles.panelHead}>
          <h3>最近审查</h3>
          <div><a className={styles.small} onClick={() => navigate('/my-contracts')} style={{ cursor: 'pointer' }}>全部记录</a></div>
        </div>
        <table className={styles.tbl}>
          <tbody>
            {recent.map((c) => {
              const n = riskCountOf(c)
              const left = daysUntil(c.retainUntil)
              return (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/review/${c.id}`)}>
                  <td style={{ width: '38%' }}>
                    <a style={{ fontWeight: 600 }}>{c.title}</a>
                    <div className={styles.cellSub}>{sceneLabel(c.scene)} · {(c.charCount || 0).toLocaleString()} 字 · {fmtDate(c.createdAt)}</div>
                  </td>
                  <td>
                    {c.review ? (
                      <span className={`${styles.tag} ${n === 0 ? styles.tagGreen : n >= 3 ? styles.tagOrange : styles.tagBlue}`}>{n} 条风险</span>
                    ) : (
                      <span className={`${styles.tag} ${styles.tagGray}`}>未审查</span>
                    )}
                  </td>
                  <td className={styles.small} style={{ color: c.retainUntil ? '#b45309' : 'var(--color-success)' }}>
                    {c.retainUntil ? `${left} 天后自动清除` : '永久存档'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <a className={styles.btnText} onClick={(e) => { e.stopPropagation(); navigate(`/review/${c.id}`) }}>查看报告</a>
                  </td>
                </tr>
              )
            })}
            {!loadingList && recent.length === 0 && (
              <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--color-text-muted)' }}>还没有审查记录</td></tr>
            )}
          </tbody>
        </table>
        <div style={{ textAlign: 'center', borderTop: '1px solid var(--color-border-light)', padding: '14px 0' }}>
          <a className={styles.small} onClick={trySample} style={{ cursor: 'pointer' }}>没有合同？体验示例合同审查报告 →</a>
        </div>
      </div>

      {/* 避坑指南 */}
      <div>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>避坑指南</h3>
        <div className={styles.grid3}>
          {GUIDES.map((g) => (
            <div key={g.title} className={`${styles.cardFlat} ${styles.guideCard}`}>
              <div className={styles.guideTop}>
                <span className={styles.ci}><QuestionCircleOutlined /></span>
                <b style={{ fontSize: 14 }}>{g.title}</b>
              </div>
              <p className={`${styles.small} ${styles.muted}`}>{g.desc}</p>
              <span className={styles.guideMore}>{g.min}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
