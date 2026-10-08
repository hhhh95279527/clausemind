// frontend/src/views/personal/ReviewResultView.jsx
// 个人审查结果页（FREE / PERSONAL 两态）：评分大白话摘要 / 风险卡 FeatureLock /
// 7 天黄条 / 合同助手 1 轮 / 底部水印 PDF 与深度导出；无人工终审。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom'
import {
  ArrowLeftOutlined, ExclamationCircleOutlined, CheckCircleOutlined,
  LockOutlined, PrinterOutlined, FileWordOutlined, EditOutlined,
} from '@ant-design/icons'
import { Spin } from 'antd'
import { useContractStore } from '@/stores/contract.js'
import { useMeStore } from '@/stores/me.js'
import { useRevisionStore } from '@/stores/revision.js'
import { useAppStore } from '@/stores/app.js'
import Paywall from '@/components/billing/Paywall.jsx'
import FeatureLock from '@/components/personal/FeatureLock.jsx'
import { sceneLabel, fmtDateCN } from './scene.js'
import { getRecommendation } from '@/config/recommendations.js'
import styles from './personal.module.css'

const SEV_META = {
  HIGH: { tag: styles.tagRed, text: '高风险', rc: styles.rcHigh },
  MED: { tag: styles.tagOrange, text: '中风险', rc: styles.rcMed },
  LOW: { tag: styles.tagBlue, text: '低风险', rc: styles.rcLow },
}

export default function ReviewResultView() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useAppStore((s) => s.toast)

  const { detail, loadDetail, startReview, reviewing, reviewStages, askContract } = useContractStore()
  const { entitlement, loadEntitlement } = useMeStore()
  const downloadDocx = useRevisionStore((s) => s.downloadDocx)

  const [paywall, setPaywall] = useState(false)
  const [rightTab, setRightTab] = useState('info')
  const [messages, setMessages] = useState([])
  const [question, setQuestion] = useState('')
  const [askLocked, setAskLocked] = useState(false)
  const [asking, setAsking] = useState(false)
  const autoStartedRef = useRef(false)

  const contract = detail?.contract
  const review = detail?.review
  const clauses = detail?.clauses || []
  const risks = review?.risks || []
  const stats = review?.stats
  const deep = !!(review?.isDeep || review?.couponUsed || entitlement?.features?.deep)
  const couponBalance = entitlement?.couponBalance ?? 0

  // 初次加载
  const refresh = useCallback(() => loadDetail(id), [id, loadDetail])
  useEffect(() => {
    loadEntitlement()
    refresh()
  }, [refresh, loadEntitlement])

  // 解析轮询 + 自动开审（?start=1[&coupon=1]）
  useEffect(() => {
    if (!contract) return
    let timer
    if (['UPLOADED', 'PARSING'].includes(contract.status)) {
      timer = setTimeout(refresh, 1500)
      return () => clearTimeout(timer)
    }
    const wantStart = params.get('start') === '1'
    if (
      wantStart &&
      !autoStartedRef.current &&
      ['READY', 'COMPLETED'].includes(contract.status) &&
      !reviewing
    ) {
      autoStartedRef.current = true
      ;(async () => {
        const { blocked } = await startReview(id, { payWithCoupon: params.get('coupon') === '1' })
        await loadEntitlement()
        if (blocked) setPaywall(true)
      })()
    }
  }, [contract?.status])

  const runWithCoupon = async () => {
    const { blocked } = await startReview(id, { payWithCoupon: true })
    await loadEntitlement()
    if (blocked) {
      setPaywall(true)
      throw new Error('blocked') // 阻止付费墙关闭
    }
  }

  const riskClauseIds = useMemo(() => new Set(risks.map((r) => r.clauseId).filter(Boolean)), [risks])
  // 场景化推荐（FR-23，纯静态）
  const recommendation = useMemo(
    () => getRecommendation(contract?.scene),
    [contract?.scene],
  )
  const greeting = useMemo(() => {
    if (!contract) return ''
    return `你好，我是这份《${contract.title}》的合同助手。可以基于合同内容免费追问 1 次，比如：押金一般交几个月？这条违约金合法吗？`
  }, [contract?.title])

  const sendQuestion = async () => {
    const q = question.trim()
    if (!q || asking) return
    setQuestion('')
    setAsking(true)
    const history = [...messages, { role: 'human', text: q }]
    setMessages(history)
    try {
      const res = await askContract(id, q)
      if (res.locked) {
        setAskLocked(true)
      } else {
        setMessages([...history, { role: 'ai', text: res.answer }])
      }
    } finally {
      setAsking(false)
    }
  }

  const exportPdf = () => window.print()

  const exportWord = async () => {
    try {
      await downloadDocx(id)
    } catch (e) {
      if (e.status === 403 && e.code === 'PLAN_LIMIT') {
        setPaywall(true)
        return
      }
      toast.warning('请先在改稿台生成并接受至少一条修订')
      navigate(`/draft/${id}`)
    }
  }

  if (!contract) {
    return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  }

  const parsing = ['UPLOADED', 'PARSING'].includes(contract.status)
  const score = stats?.score
  const scoreClass = score == null ? '' : score >= 85 ? styles.scoreLow : score < 75 ? styles.scoreHigh : ''

  return (
    <div className={styles.wrap}>
      {/* 标题行 */}
      <div className={styles.titleRow}>
        <Link to="/my-contracts" className={styles.small} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-text-sub)' }}>
          <ArrowLeftOutlined style={{ fontSize: 12 }} />我的合同
        </Link>
        <h2 style={{ fontSize: 16, margin: 0 }}>审查结果</h2>
        {stats && (
          <span className={`${styles.tag} ${stats.total === 0 ? styles.tagGreen : styles.tagOrange}`}>{stats.total} 条风险</span>
        )}
      </div>

      {parsing && (
        <div className={styles.panel}><div className={styles.panelBody} style={{ textAlign: 'center' }}>
          <Spin /> <span style={{ marginLeft: 10 }}>正在解析合同条款…</span>
        </div></div>
      )}

      {reviewing && (
        <div className={`${styles.banner} ${styles.bannerInfo}`}>
          <Spin size="small" />
          <div>正在审查{reviewStages.length ? `：${reviewStages[reviewStages.length - 1]?.message || ''}` : '…'}</div>
        </div>
      )}

      {contract.parseError && (
        <div className={`${styles.banner} ${styles.bannerDanger}`}>
          <ExclamationCircleOutlined style={{ marginTop: 3, flex: 'none' }} />
          <div>合同解析失败：{contract.parseError}</div>
        </div>
      )}

      <div className={styles.reviewGrid}>
        {/* 左：条款列 */}
        <div className={styles.panel}>
          <div className={styles.panelHead}>
            <h3>合同条款</h3>
            <span className={`${styles.small} ${styles.muted}`}>{clauses.length} 条 · {(contract.charCount || 0).toLocaleString()} 字</span>
          </div>
          <div style={{ maxHeight: 640, overflowY: 'auto' }}>
            {clauses.map((c) => (
              <div key={c.id} className={`${styles.clauseItem} ${riskClauseIds.has(c.id) ? styles.clauseItemOn : ''}`}>
                <div className={styles.clauseTitle}>
                  {c.indexNo === 0 ? c.title : `第${c.indexNo}条 ${c.title}`}
                  {riskClauseIds.has(c.id) && <span className={`${styles.tag} ${styles.tagOrange}`}>风险</span>}
                </div>
                <div className={styles.clauseContent}>{c.content}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 中：评分 + 风险卡 */}
        <div>
          <div className={styles.titleRow}>
            <h2>{contract.title}</h2>
            <span className={`${styles.tag} ${styles.tagBlue}`}>{sceneLabel(contract.scene)}</span>
          </div>

          {/* 评分摘要 */}
          <div className={styles.panel} style={{ marginBottom: 12 }}>
            <div className={`${styles.panelBody} ${styles.scoreBox}`}>
              <div className={`${styles.score} ${scoreClass}`}>
                {score ?? '—'}
                <small>{stats?.scoreLevel || '待审查'}</small>
              </div>
              <div>
                <b style={{ fontSize: 14 }}>大白话摘要</b>
                <ul className={styles.sumList}>
                  {(stats?.summary || []).map((s, i) => (
                    <li key={i}><b>{s.title}：</b>{s.text}</li>
                  ))}
                  {stats && stats.total === 0 && <li>没有发现明显风险点，仍建议逐条确认关键条款。</li>}
                  {!stats && <li>审查完成后，这里会用大白话告诉你合同里最需要注意的 3 件事。</li>}
                </ul>
              </div>
            </div>
          </div>

          {/* 存档提示 */}
          {!deep ? (
            <div className={`${styles.banner} ${styles.bannerWarn}`} style={{ marginBottom: 12 }}>
              <ExclamationCircleOutlined style={{ flex: 'none', marginTop: 3 }} />
              <div>
                免费审查记录保留 7 天，<b>{contract.retainUntil ? `${fmtDateCN(contract.retainUntil)}自动清除` : '7 天后自动清除'}</b>
                ；升级个人版后永久存档。
              </div>
            </div>
          ) : (
            <div className={`${styles.banner} ${styles.bannerSuccess}`} style={{ marginBottom: 12 }}>
              <CheckCircleOutlined style={{ flex: 'none', marginTop: 3 }} />
              <div><b>个人版 · 永久存档。</b>该份审查与改稿记录将长期保留，可随时导出 Word 修订稿。</div>
            </div>
          )}

          {/* 风险卡 */}
          {risks.map((r) => {
            const meta = SEV_META[r.severity] || SEV_META.LOW
            return (
              <div key={r.id} className={`${styles.riskCard} ${meta.rc}`}>
                <div className={styles.riskHead}>
                  <span className={`${styles.tag} ${meta.tag}`}>{meta.text}</span>
                  <b>{r.title}</b>
                </div>
                <div className={styles.riskQuote}>原文：「{r.quote}」</div>
                <div className={styles.riskPlain}>{r.analysis}</div>
                <FeatureLock
                  locked={!deep}
                  legalBasis={r.legalBasis}
                  suggestion={r.suggestion}
                  rewritten={r.rewritten}
                  onUpgrade={() => navigate('/checkout?plan=PERSONAL&period=monthly')}
                  onCoupon={() => setPaywall(true)}
                />
                <div className={styles.riskMeta}>
                  命中条款：{r.clauseTitle || '未关联'} · {r.detectedBy === 'AGENT' ? 'AI 语义审查命中' : r.detectedBy === 'BOTH' ? '规则 + AI 双重命中' : r.detectedBy === 'PLAYBOOK' ? (r.category === '偏好口径' ? '公司偏好规则命中' : '公司红线规则命中') : '规则引擎命中'}
                </div>
              </div>
            )
          })}

          {/* 场景化推荐（FR-23）：看完这份合同，建议你再关注 */}
          <div className={styles.panel} style={{ marginTop: 12 }}>
            <div className={styles.panelHead}>
              <h3>看完这份合同，建议你再关注</h3>
            </div>
            <div className={styles.panelBody}>
              <b style={{ fontSize: 14 }}>{recommendation.guide.title}</b>
              <ul className={styles.sumList}>
                {recommendation.guide.bullets.map((b, i) => <li key={i}>{b}</li>)}
              </ul>
              <div
                className={`${styles.small} ${styles.muted}`}
                style={{ margin: '8px 0 6px' }}
              >
                相关范本（可在范本库直接采用 / 下载）
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {recommendation.templates.map((t) => (
                  <button
                    key={t.docId}
                    className="btn btn-ghost btn-sm"
                    onClick={() => navigate('/templates')}
                    title={t.title}
                  >
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 右：概览 / 助手 */}
        <div className={styles.panel} style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border-light)' }}>
            <button
              className={styles.segItem}
              style={{ flex: 1, padding: '10px 16px', fontSize: 13, borderRadius: 0, background: 'none', border: 'none', borderBottom: rightTab === 'info' ? '2px solid var(--color-primary)' : '2px solid transparent', color: rightTab === 'info' ? 'var(--color-primary)' : 'var(--color-text-sub)', fontWeight: rightTab === 'info' ? 600 : 400 }}
              onClick={() => setRightTab('info')}
            >审查概览</button>
            <button
              className={styles.segItem}
              style={{ flex: 1, padding: '10px 16px', fontSize: 13, borderRadius: 0, background: 'none', border: 'none', borderBottom: rightTab === 'assistant' ? '2px solid var(--color-primary)' : '2px solid transparent', color: rightTab === 'assistant' ? 'var(--color-primary)' : 'var(--color-text-sub)', fontWeight: rightTab === 'assistant' ? 600 : 400 }}
              onClick={() => setRightTab('assistant')}
            >合同助手</button>
          </div>

          {rightTab === 'info' ? (
            <div className={styles.panelBody}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                <span className={`${styles.tag} ${styles.tagRed}`}>高 {stats?.high ?? 0}</span>
                <span className={`${styles.tag} ${styles.tagOrange}`}>中 {stats?.med ?? 0}</span>
                <span className={`${styles.tag} ${styles.tagBlue}`}>低 {stats?.low ?? 0}</span>
              </div>
              <div className={styles.stageLine}>
                <div className={styles.stageItem}>
                  <span className={`${styles.stageDot} ${styles.stageDone}`}>✓</span>
                  <div><b>文件解析</b><div className={`${styles.small} ${styles.muted}`}>{clauses.length} 条条款 · {(contract.charCount || 0).toLocaleString()} 字</div></div>
                </div>
                <div className={styles.stageItem}>
                  <span className={`${styles.stageDot} ${styles.stageDone}`}>✓</span>
                  <div><b>规则审查</b><div className={`${styles.small} ${styles.muted}`}>命中 {stats?.rule ?? risks.length} 条风险规则</div></div>
                </div>
                <div className={styles.stageItem}>
                  <span className={`${styles.stageDot} ${styles.stageDone}`}>✓</span>
                  <div><b>风险清单</b><div className={`${styles.small} ${styles.muted}`}>风险清单已生成</div></div>
                </div>
                <div className={styles.stageItem}>
                  <span className={`${styles.stageDot} ${deep ? styles.stageDone : styles.stageWait}`}>
                    {deep ? '✓' : <LockOutlined style={{ fontSize: 10 }} />}
                  </span>
                  <div>
                    <b>AI 语义审查</b>
                    <div className={`${styles.small} ${styles.muted}`} style={{ margin: '2px 0 5px' }}>
                      {deep ? '检索法规并生成修改建议与替代措辞' : '法条依据、修改建议、替代措辞'}
                    </div>
                    {!deep && <button className="btn btn-primary btn-sm" onClick={() => setPaywall(true)}>个人版权益</button>}
                  </div>
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--color-border-light)', margin: '16px 0' }} />
              <div className={`${styles.small} ${styles.muted}`} style={{ lineHeight: 2 }}>
                审查方式：规则引擎（免费）{deep && <span> + AI 语义审查（个人版）</span>}<br />
                审查时间：{review?.createdAt ? new Date(review.createdAt).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-') : '—'}<br />
                法规库版本：{new Date().toISOString().slice(0, 7)}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div className={styles.chatStream}>
                <div className={`${styles.bubble} ${styles.bubbleAi}`}>{greeting}</div>
                {messages.map((m, i) => (
                  <div key={i} className={`${styles.bubble} ${m.role === 'ai' ? styles.bubbleAi : styles.bubbleHuman}`}>{m.text}</div>
                ))}
                {asking && <div className={`${styles.bubble} ${styles.bubbleAi}`}><Spin size="small" /></div>}
                {askLocked && (
                  <div className={styles.miniLock}>
                    <LockOutlined />
                    <span>继续追问 / 帮我改这条 / 模拟反驳：个人版权益</span>
                    <button className="btn btn-primary btn-sm" onClick={() => setPaywall(true)}>解锁</button>
                  </div>
                )}
              </div>
              {deep && (
                <div className={styles.aiButtons}>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/draft/${id}`)}>帮我改这条</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/draft/${id}`)}>模拟对方反驳</button>
                  <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => navigate(`/draft/${id}`)}>
                    一键生成修订稿
                  </button>
                </div>
              )}
              <div className={styles.chatInputBar}>
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value.slice(0, 500))}
                  onKeyDown={(e) => e.key === 'Enter' && sendQuestion()}
                  placeholder={askLocked ? '继续追问为个人版权益' : '就这份合同继续提问…'}
                  disabled={askLocked || asking}
                />
                <button className="btn btn-primary" onClick={sendQuestion} disabled={askLocked || asking || !question.trim()}>发送</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 底部操作条 */}
      <div className={styles.panel}>
        <div className={`${styles.panelBody} ${styles.bottomBar}`}>
          <button className="btn btn-ghost" onClick={exportPdf}>
            <PrinterOutlined /> {deep ? '导出审查摘要 PDF' : '导出水印摘要 PDF'}
          </button>
          {deep ? (
            <button className="btn btn-ghost" onClick={exportWord}><FileWordOutlined /> Word 红划线导出 .docx</button>
          ) : (
            <button className="btn btn-ghost" onClick={() => setPaywall(true)}><LockOutlined /> Word 红划线导出</button>
          )}
          {deep
            ? <button className="btn btn-primary" onClick={() => navigate(`/draft/${id}`)}><EditOutlined /> 一键生成修订稿</button>
            : <button className="btn btn-ghost" onClick={() => setPaywall(true)}>一键生成修订稿</button>}
          <span className={`${styles.small} ${styles.muted}`} style={{ marginLeft: 'auto' }}>
            {deep
              ? '修订记录与本份报告将永久存档'
              : '免费 PDF 含水印与「不构成法律意见」免责声明；深度导出为个人版权益'}
          </span>
        </div>
      </div>

      <div className={styles.disclaimer}>AI 仅做风险提示，不构成法律意见，重大合同建议咨询执业律师。</div>

      <Paywall
        open={paywall}
        onClose={() => setPaywall(false)}
        couponBalance={couponBalance}
        onUseCoupon={runWithCoupon}
      />

      {/* 打印用：水印摘要（屏幕不可见） */}
      <div id="printArea" style={{ display: 'none' }}>
        <h1>{contract.title} · 风险审查摘要</h1>
        <p>风险评分：{score ?? '—'}（{stats?.scoreLevel || '—'}） · {sceneLabel(contract.scene)} · {new Date().toLocaleDateString('zh-CN')}</p>
        {!deep && <div className="printWatermark"><b>ClauseMind 免费版</b></div>}
        <h2>大白话摘要</h2>
        <ol>{(stats?.summary || []).map((s, i) => <li key={i}><b>{s.title}：</b>{s.text}</li>)}</ol>
        <h2>风险清单（{stats?.total ?? 0} 条）</h2>
        <ol>{risks.map((r) => <li key={r.id}>[{SEV_META[r.severity]?.text}] {r.title}：{r.analysis}</li>)}</ol>
        <p style={{ marginTop: 24, color: '#6b7280' }}>AI 仅做风险提示，不构成法律意见，重大合同建议咨询执业律师。</p>
      </div>
    </div>
  )
}
