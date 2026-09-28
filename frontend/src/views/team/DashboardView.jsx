// frontend/src/views/team/DashboardView.jsx
// 企业合规仪表盘（FR-15）：统计卡 / 待办 / 近 30 天风险 / 台账到期 / 套餐用量 / Playbook 命中
import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Empty, Spin, Tag } from 'antd'
import {
  FileTextOutlined, BookOutlined, SafetyCertificateFilled,
  CheckCircleOutlined, WarningOutlined, CalendarOutlined,
  CloudUploadOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useDashboardStore } from '@/stores/dashboard.js'
import { useMeStore } from '@/stores/me.js'
import styles from './dashboard.module.css'

const pad = (n) => String(n).padStart(2, '0')

function formatTime(d) {
  const date = new Date(d)
  const now = new Date()
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const yest = new Date(now); yest.setDate(now.getDate() - 1)
  if (sameDay(date, now)) return `今天 ${hm}`
  if (sameDay(date, yest)) return `昨天 ${hm}`
  return `${pad(date.getMonth() + 1)}月${pad(date.getDate())}日`
}

function deadlineTag(d) {
  if (d.kind === 'PROBATION') {
    return { color: 'default', text: d.days < 0 ? '试用期已过' : '试用期到期' }
  }
  if (d.bucket === 'EXPIRED') return { color: 'error', text: '已过期' }
  if (d.bucket === 'DUE_30') return { color: 'warning', text: `${d.days} 天后到期` }
  return { color: 'default', text: `${d.days} 天后到期` }
}

const Bar = ({ label, value, max, color }) => (
  <div className={styles.barRow}>
    <span className={styles.barLabel}>{label}</span>
    <span className={styles.barTrack}><i style={{ width: `${max ? Math.max(4, (value / max) * 100) : 0}%`, background: color }} /></span>
    <span className={styles.barValue}>{value}</span>
  </div>
)

export default function DashboardView() {
  const navigate = useNavigate()
  const { data, loading, loadSummary } = useDashboardStore()
  const { entitlement, loadEntitlement } = useMeStore()

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => {
    if (entitlement?.workspaceType === 'TEAM') loadSummary()
  }, [entitlement?.workspaceType, loadSummary])

  const greeting = useMemo(() => {
    const h = new Date().getHours()
    if (h < 11) return '早上好'
    if (h < 14) return '中午好'
    if (h < 18) return '下午好'
    return '晚上好'
  }, [])

  // 个人空间：加锁付费墙
  if (entitlement && entitlement.workspaceType !== 'TEAM') {
    return (
      <div className={styles.lockWrap}>
        <div className={styles.lockCard}>
          <div className={styles.lockIcon}><SafetyCertificateFilled /></div>
          <h3>合规仪表盘为团队版 / 企业版权益</h3>
          <p className={styles.lockMuted}>个人版（PERSONAL）不支持团队级合规数据汇总</p>
          <ul className={styles.lockFeats}>
            <li><span className={styles.tick}>✓</span>待审批与公司红线命中待办，团队统一处理</li>
            <li><span className={styles.tick}>✓</span>近 30 天风险趋势与高频风险类别 Top 5</li>
            <li><span className={styles.tick}>✓</span>合同到期提醒、套餐用量与 Playbook 命中概览</li>
          </ul>
          <Button type="primary" size="large" block onClick={() => navigate('/pricing')}>了解团队版 TEAM</Button>
        </div>
      </div>
    )
  }

  if (loading && !data) {
    return <div className={styles.center}><Spin size="large" tip="加载仪表盘…" /></div>
  }
  if (!data) return <Empty description="仪表盘数据暂不可用" className={styles.center} />

  const { stats, todos, topCategories, deadlines, playbookHits, risk30d } = {
    stats: data.stats, todos: data.todos || [], topCategories: data.topCategories || [],
    deadlines: data.deadlines || [], playbookHits: data.playbookHits || [], risk30d: data.stats.risk30d,
  }
  const plan = data.plan || {}
  const todoCount = todos.length
  const reviewPct = stats.reviewQuota ? Math.min(100, (stats.monthReviews / stats.reviewQuota) * 100) : 0
  const seatPct = plan.seats ? Math.min(100, (plan.usedSeats / plan.seats) * 100) : 0
  const catMax = topCategories[0]?.count || 0

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div>
          <div className={styles.title}>合规仪表盘</div>
          <div className={styles.subtitle}>
            {greeting}，今天有 {todoCount} 件合同事务待处理
          </div>
        </div>
        <div className={styles.toolbarRight}>
          <Tag color="purple">{plan.label || '团队版'}</Tag>
          <Button icon={<ReloadOutlined />} onClick={loadSummary} loading={loading}>刷新</Button>
        </div>
      </div>

      {/* 快捷操作 */}
      <div className={styles.quickGrid}>
        <a className={styles.quickCard} onClick={() => navigate('/contracts')}>
          <div className={styles.quickIcon}><CloudUploadOutlined /></div>
          <div>
            <h3>上传合同审查</h3>
            <p>支持 Word / PDF / 拍照</p>
          </div>
        </a>
        <a className={styles.quickCard} onClick={() => navigate('/templates')}>
          <div className={styles.quickIcon}><BookOutlined /></div>
          <div>
            <h3>找一份范本</h3>
            <p>12 套常用合同文书</p>
          </div>
        </a>
        <a className={styles.quickCard} onClick={() => navigate('/playbook')}>
          <div className={styles.quickIcon}><SafetyCertificateFilled /></div>
          <div>
            <h3>配置审查规则</h3>
            <p>红线 / 偏好 / 标准合同</p>
          </div>
        </a>
      </div>

      {/* 统计卡 */}
      <div className={styles.statGrid}>
        <div className={styles.statCard}>
          <div className={styles.statTop}><FileTextOutlined /> 本月审查</div>
          <div className={styles.statNum}>
            {stats.monthReviews}
            {stats.reviewQuota && <span className={styles.statUnit}> / {stats.reviewQuota} 份</span>}
          </div>
          <div className={styles.progress}>
            <i style={{ width: stats.reviewQuota ? `${reviewPct}%` : '0%' }} />
          </div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statTop}><CheckCircleOutlined /> 待审批</div>
          <div className={`${styles.statNum} ${styles.warning}`}>{stats.pendingApproval}</div>
          <div className={styles.statFoot}>{stats.pendingApproval} 份合同等待法务 / 负责人审批</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statTop}><WarningOutlined /> 近 30 天高风险</div>
          <div className={`${styles.statNum} ${styles.danger}`}>{risk30d.high}</div>
          <div className={styles.statFoot}>中风险 {risk30d.med} · 低风险 {risk30d.low}</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statTop}><CalendarOutlined /> 台账临期</div>
          <div className={`${styles.statNum} ${styles.danger}`}>
            {stats.due30Ledger + stats.expiredLedger}<span className={styles.statUnit}> 份</span>
          </div>
          <div className={styles.statFoot}>
            {stats.expiredLedger > 0
              ? <>其中 {stats.expiredLedger} 份已过期，<a onClick={() => navigate('/ledger')}>去处理</a></>
              : <a onClick={() => navigate('/ledger')}>查看合同台账</a>}
          </div>
        </div>
      </div>

      <div className={styles.dashCols}>
        <div className={styles.col}>
          {/* 待办 */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>待办事项</h3>
              <a className={styles.smallLink} onClick={() => navigate('/contracts')}>全部合同</a>
            </div>
            <div className={styles.panelBody}>
              {todos.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无待办" />}
              {todos.map((t) => (
                <div
                  key={`${t.kind}-${t.taskId || t.contractId}`}
                  className={styles.todoItem}
                  onClick={() => navigate(`/contracts/${t.contractId}`)}
                >
                  {t.kind === 'WAITING_REVIEW' ? (
                    <>
                      <Tag color="orange" className={styles.dotTag}>待法务审</Tag>
                      <div className={styles.todoMain}>
                        <b>{t.title}</b>
                        <div>{t.riskCount} 条风险待确认{t.playbookCount > 0 ? ` · 命中 ${t.playbookCount} 条公司红线` : ''}</div>
                      </div>
                      <span className={styles.todoTime}>{formatTime(t.createdAt)}</span>
                    </>
                  ) : (
                    <>
                      <Tag color="error" className={styles.dotTag}>解析失败</Tag>
                      <div className={styles.todoMain}>
                        <b>{t.title}</b>
                        <div>{t.parseError || '文件内容无法识别，建议重新上传清晰照片或粘贴文本'}</div>
                      </div>
                      <Button size="small" onClick={(e) => { e.stopPropagation(); navigate('/contracts') }}>重新上传</Button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 风险概览 */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>近 30 天风险概览</h3>
              <span className={styles.mutedSmall}>共 {risk30d.total} 条 · 来自 {risk30d.contracts} 份合同</span>
            </div>
            <div className={styles.panelBodyPad}>
              <Bar label="高风险" value={risk30d.high} max={Math.max(risk30d.high, risk30d.med, risk30d.low, 1)} color="var(--color-danger)" />
              <Bar label="中风险" value={risk30d.med} max={Math.max(risk30d.high, risk30d.med, risk30d.low, 1)} color="var(--color-warning)" />
              <Bar label="低风险" value={risk30d.low} max={Math.max(risk30d.high, risk30d.med, risk30d.low, 1)} color="var(--color-info)" />
              <div className={styles.divider} />
              <div className={styles.mutedSmall} style={{ marginBottom: 8 }}>高频风险类别 Top 5</div>
              {topCategories.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 30 天暂无风险数据" />}
              {topCategories.map((c) => (
                <Bar key={c.category} label={c.category} value={c.count} max={catMax} color="var(--color-primary)" />
              ))}
            </div>
          </div>
        </div>

        <div className={styles.col}>
          {/* 到期提醒 */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>合同到期提醒</h3>
              <a className={styles.smallLink} onClick={() => navigate('/ledger')}>合同台账</a>
            </div>
            <div className={styles.panelBody}>
              {deadlines.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 90 天无到期合同" />}
              {deadlines.map((d) => {
                const tg = deadlineTag(d)
                const dd = new Date(d.date)
                const mdText = `${pad(dd.getMonth() + 1)}月${pad(dd.getDate())}日`
                return (
                  <div key={`${d.ledgerId}-${d.kind}`} className={styles.deadlineRow}
                    onClick={() => navigate('/ledger')}>
                    <Tag color={tg.color}>{tg.text}</Tag>
                    <b>
                      {d.kind === 'PROBATION'
                        ? `${d.name} · 试用期 ${mdText}`
                        : `${d.name} · ${d.contractTypeLabel}`}
                    </b>
                    <span className={styles.deadlineDate}>{`${dd.getFullYear()}-${pad(dd.getMonth() + 1)}-${pad(dd.getDate())}`}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* 套餐用量 */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>本月套餐用量</h3>
              <Tag color="purple">{plan.plan || 'TEAM'}</Tag>
            </div>
            <div className={styles.panelBodyPad}>
              <div className={styles.usageLine}>
                <span>智能审查</span>
                <b>{stats.monthReviews} {stats.reviewQuota ? `/ ${stats.reviewQuota} 份` : '份 · 不限'}</b>
              </div>
              <div className={styles.progress}><i style={{ width: `${reviewPct}%` }} /></div>
              <div className={styles.usageLine} style={{ marginTop: 14 }}>
                <span>团队席位</span>
                <b>{plan.usedSeats} {plan.seats ? `/ ${plan.seats} 席` : '席 · 不限'}</b>
              </div>
              <div className={styles.progress}><i style={{ width: `${seatPct}%` }} /></div>
              <div className={styles.usageLine} style={{ marginTop: 14 }}>
                <span>台账条目</span>
                <b>{stats.ledgerTotal} 条 · {stats.ledgerMaxItems ? `最多 ${stats.ledgerMaxItems}` : '不限'}</b>
              </div>
              <Button block style={{ marginTop: 16 }} onClick={() => navigate('/billing')}>管理套餐与用量</Button>
            </div>
          </div>

          {/* Playbook 命中概览 */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <h3>Playbook 命中概览</h3>
              <Tag color="purple">公司规则</Tag>
            </div>
            <div className={styles.panelBody}>
              {playbookHits.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="近 30 天暂无公司规则命中" />}
              {playbookHits.map((r) => (
                <div key={r.id} className={styles.todoItem} onClick={() => navigate('/playbook')}>
                  <Tag color={r.kind === 'FORBIDDEN' ? 'error' : 'warning'}>
                    {r.kind === 'FORBIDDEN' ? '红线' : '口径'}
                  </Tag>
                  <div className={styles.todoMain}>
                    <b>{r.title}</b>
                    {(r.contractTypes?.length > 0 || r.description) && <div>{r.description || r.contractTypes.join(' / ')}</div>}
                  </div>
                  <span className={styles.hitCount}>命中 {r.hits} 次</span>
                </div>
              ))}
              {playbookHits.length > 0 && (
                <div className={styles.panelFooter}>
                  <a className={styles.smallLink} onClick={() => navigate('/playbook')}>查看全部规则与命中详情 →</a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
