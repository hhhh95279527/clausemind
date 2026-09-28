// frontend/src/views/contract/ReviewWorkbench.jsx
// 合同审查工作台：左条款（风险定位高亮）／中风险卡片流（终审处置）／右审查进程与结论（意见书）
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button, Tag, Spin, Empty, Segmented, Modal, App, Statistic, Badge, Divider, Tooltip, Input,
} from 'antd'
import {
  ArrowLeftOutlined, PlayCircleOutlined, FileSearchOutlined, PrinterOutlined,
  FileWordOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, WarningOutlined,
  SafetyCertificateFilled, MessageOutlined, RedoOutlined,
} from '@ant-design/icons'
import { useContractStore, CONTRACT_STATUS_META, SEVERITY_TEXT } from '@/stores/contract.js'
import { useAuthStore } from '@/stores/auth.js'
import { useMeStore } from '@/stores/me.js'
import http from '@/utils/http.js'
import RiskCard from '@/components/contract/RiskCard.jsx'
import styles from './ReviewWorkbench.module.css'

const CLAUSE_TYPE_TEXT = {
  PARTIES: '缔约信息', AMOUNT: '价款支付', TERM: '期限交付', BREACH: '违约责任',
  TERMINATION: '解除终止', GOVERNING_LAW: '争议解决', CONFIDENTIALITY: '保密条款',
  IP: '知识产权', OTHER: '其他',
}

const SCENE_TEXT = {
  LABOR: '劳动', LEASE: '租赁', SERVICE: '劳务', NDA: '保密', CUSTOM: '非标',
}

export default function ReviewWorkbench() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { message, modal } = App.useApp()
  const role = useAuthStore((s) => s.user?.role)
  const canDecide = role === 'ADMIN' || role === 'MANAGER'
  const { entitlement, loadEntitlement } = useMeStore()
  const isTeamSpace = entitlement?.workspaceType === 'TEAM'

  const {
    detail, loadingDetail, loadDetail,
    reviewing, reviewStages, liveRisks, reviewStats, reviewError, resetReviewRun, startReview,
    submitDecision, loadReport, downloadReportDocx,
  } = useContractStore()

  const [selectedClause, setSelectedClause] = useState(null)
  const [sevFilter, setSevFilter] = useState('ALL')
  const [keyword, setKeyword] = useState('')
  const [decisions, setDecisions] = useState({})   // { [riskId]: { status, comment } }
  const [submitting, setSubmitting] = useState(false)
  const [reportMd, setReportMd] = useState('')
  const [reportHtml, setReportHtml] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [exportingReport, setExportingReport] = useState(false)
  // 企业态：结构化信息卡 + 审批评论
  const [structured, setStructured] = useState(null)
  const [structuredLoading, setStructuredLoading] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentSending, setCommentSending] = useState(false)
  const riskRefs = useRef({})

  useEffect(() => { loadEntitlement() }, [loadEntitlement])

  // markdown 渲染器（marked+hljs 近 1MB）仅在意见书弹窗实际打开时动态加载，不拖慢工作台首屏
  const showReport = (md) => {
    setReportMd(md)
    setReportHtml('')
    setReportOpen(true)
    import('@/utils/markdown.js').then(({ renderMarkdown }) => setReportHtml(renderMarkdown(md)))
  }

  useEffect(() => {
    resetReviewRun()
    loadDetail(id)
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps

  const contract = detail?.contract
  const clauses = detail?.clauses || []
  const review = detail?.review
  const risks = review?.risks || []

  // 解析中自动轮询
  useEffect(() => {
    if (!contract || !['UPLOADED', 'PARSING'].includes(contract.status)) return
    const timer = setInterval(() => loadDetail(id), 3000)
    return () => clearInterval(timer)
  }, [contract?.status, id]) // eslint-disable-line react-hooks/exhaustive-deps

  // 条款 → 风险索引
  const clauseRiskMap = useMemo(() => {
    const m = {}
    for (const r of risks) {
      if (!r.clauseId) continue
      ;(m[r.clauseId] ||= []).push(r)
    }
    return m
  }, [risks])

  const filteredRisks = useMemo(() => risks.filter((r) => {
    if (sevFilter !== 'ALL' && r.severity !== sevFilter) return false
    if (keyword && !`${r.title}${r.analysis}${r.quote}`.includes(keyword.trim())) return false
    return true
  }), [risks, sevFilter, keyword])

  const reviewOpen = review?.status === 'WAITING_REVIEW' && !reviewing
  const stats = review?.stats
  const acceptedCount = risks.filter((r) => r.status === 'ACCEPTED').length

  // 企业态：Playbook 命中分区（公司红线/偏好 vs 通用风险）
  const playbookRisks = useMemo(
    () => filteredRisks.filter((r) => r.detectedBy === 'PLAYBOOK'),
    [filteredRisks],
  )
  const normalRisks = useMemo(
    () => filteredRisks.filter((r) => r.detectedBy !== 'PLAYBOOK'),
    [filteredRisks],
  )
  const playbookTotal = risks.filter((r) => r.detectedBy === 'PLAYBOOK').length
  const redlineTotal = risks.filter(
    (r) => r.detectedBy === 'PLAYBOOK' && r.category !== '偏好口径',
  ).length

  // 企业态：结构化信息（详情带缓存直接用；否则请求 AI 抽取，409/400 静默隐藏卡片）
  const refreshStructured = async (force = false) => {
    setStructuredLoading(true)
    try {
      const d = await http.get(
        `/contracts/${id}/structured${force ? '?force=1' : ''}`,
        { skipErrorToast: true },
      )
      if (d.structured) setStructured(d.structured)
    } catch { /* 无 Key 或无条款：不展示该卡 */ }
    finally { setStructuredLoading(false) }
  }
  useEffect(() => {
    setStructured(null)
    if (!isTeamSpace || !contract) return
    if (contract.structuredInfo) { setStructured(contract.structuredInfo); return }
    refreshStructured(false)
  }, [isTeamSpace, id, contract?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const submitComment = async () => {
    const c = commentText.trim()
    if (!c) { message.warning('请输入评论内容'); return }
    setCommentSending(true)
    try {
      await http.post(`/reviews/${review.id}/comment`, { comment: c })
      message.success('评论已记录到审批日志')
      setCommentOpen(false)
      setCommentText('')
    } finally { setCommentSending(false) }
  }

  const handleStart = async () => {
    setDecisions({})
    await startReview(id)
    const d = useContractStore.getState().detail
    if (d?.review?.status === 'WAITING_REVIEW') message.success('规则扫描完成，等待人工终审')
  }

  const decide = (riskId, patch) => {
    setDecisions((m) => ({ ...m, [riskId]: { ...m[riskId], ...patch } }))
  }

  const selectClauseAndScroll = (clauseId) => {
    setSelectedClause(clauseId)
    const first = clauseRiskMap[clauseId]?.[0]
    const el = first && riskRefs.current[first.id]
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const openReport = async () => {
    try {
      const md = await loadReport(review.id)
      showReport(md)
    } catch { /* toast 已统一处理 */ }
  }

  const handleFinal = async (finalDecision) => {
    const accepted = Object.values(decisions).filter((d) => d.status === 'ACCEPTED').length
    if (finalDecision === 'APPROVED') {
      modal.confirm({
        title: '确认审查通过？',
        content: `已采纳 ${accepted} 项风险，意见书将据此生成；其余风险保留在报告中供参考。`,
        okText: '确认通过并生成意见书',
        cancelText: '再看看',
        onOk: () => doSubmit('APPROVED'),
      })
    } else {
      modal.confirm({
        title: '驳回合同？',
        content: '合同将退回「待审查」状态，可修改后重新发起审查。',
        okText: '确认驳回',
        okButtonProps: { danger: true },
        cancelText: '取消',
        onOk: () => doSubmit('REJECTED'),
      })
    }
  }

  const doSubmit = async (finalDecision) => {
    setSubmitting(true)
    try {
      const actions = Object.entries(decisions)
        .filter(([, d]) => d.status)
        .map(([riskId, d]) => ({ riskId, status: d.status, comment: d.comment || null }))
      const res = await submitDecision(review.id, { finalDecision, actions })
      message.success(finalDecision === 'APPROVED' ? '终审完成，意见书已生成' : '已驳回，合同回到待审查状态')
      await loadDetail(id)
      if (finalDecision === 'APPROVED' && res.reportMd) {
        showReport(res.reportMd)
      }
    } finally { setSubmitting(false) }
  }

  const printReport = async () => {
    const { renderMarkdown } = await import('@/utils/markdown.js')
    const html = renderMarkdown(reportMd)
    const w = window.open('', '_blank', 'width=900,height=1000')
    if (!w) { message.warning('浏览器拦截了打印窗口，请允许弹窗'); return }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>审查意见书</title>
      <style>
        body{font-family:"Microsoft YaHei",sans-serif;max-width:820px;margin:40px auto;padding:0 24px;line-height:1.8;color:#111}
        blockquote{border-left:4px solid #d97706;background:#faf7f0;margin:8px 0;padding:8px 14px;color:#444}
        h1{font-size:24px}h2{font-size:18px;margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:6px}
        h3{font-size:15px;margin-top:20px}
      </style></head><body>${html}</body></html>`)
    w.document.close()
    w.focus()
    setTimeout(() => w.print(), 300)
  }

  // 意见书 Word 导出（FR-21，归属/终审状态/套餐权益由后端三校验）
  const exportReportDocx = async () => {
    setExportingReport(true)
    try {
      await downloadReportDocx(review.id, `审查意见书_${contract.title}.docx`)
    } catch (e) {
      message.warning(e?.status === 403
        ? (e.message || '当前套餐不支持导出 Word 意见书')
        : '意见书尚未生成或导出失败')
    } finally {
      setExportingReport(false)
    }
  }

  if (loadingDetail && !detail) {
    return <div className={styles.center}><Spin size="large" tip="加载合同…" /></div>
  }
  if (!contract) return <Empty description="合同不存在或无权访问" className={styles.center} />

  const statusMeta = CONTRACT_STATUS_META[contract.status]

  return (
    <div className={styles.page}>
      {/* 顶栏 */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/contracts')} />
          <div>
            <div className={styles.title}>
              {contract.title}
              <Tag color={statusMeta?.color} style={{ marginLeft: 8 }}>{statusMeta?.text}</Tag>
              {isTeamSpace && playbookTotal > 0 && (
                <Tag color="purple" style={{ marginLeft: 4 }}>Playbook 命中 {playbookTotal} 条</Tag>
              )}
            </div>
            <div className={styles.subtitle}>
              {contract.fileName} · {contract.clausesCount} 条 · {contract.charCount} 字
            </div>
          </div>
        </div>
        <div className={styles.headerRight}>
          <Button icon={<ReloadOutlined />} onClick={() => loadDetail(id)}>刷新</Button>
          {contract.reportMd && <Button icon={<FileSearchOutlined />} onClick={openReport}>查看意见书</Button>}
          <Button
            type="primary" icon={<PlayCircleOutlined />}
            loading={reviewing}
            disabled={['UPLOADED', 'PARSING', 'REVIEWING', 'FAILED'].includes(contract.status)}
            onClick={handleStart}
          >
            {review ? '重新发起审查' : '发起 AI 审查'}
          </Button>
        </div>
      </div>

      {contract.status === 'FAILED' && (
        <div className={styles.errorBar}>
          <WarningOutlined /> 条款解析失败：{contract.parseError || '未知原因'}（可能为扫描版 PDF，请改为文本版或直接粘贴文本）
        </div>
      )}

      {/* 企业审批流条 */}
      {isTeamSpace && reviewOpen && (
        <div className={styles.approvalBar}>
          <div className={styles.approvalLeft}>
            <SafetyCertificateFilled className={styles.approvalIcon} />
            <span>
              {redlineTotal > 0
                ? <>命中公司{SCENE_TEXT[contract.scene] || ''} Playbook 红线 <b>{redlineTotal}</b> 条，法务终审前请处理</>
                : <>未命中公司{SCENE_TEXT[contract.scene] || ''} Playbook 红线，可进入终审流程</>}
            </span>
            {playbookTotal > 0 && <Tag color="purple" style={{ marginLeft: 8 }}>Playbook 命中 {playbookTotal} 条</Tag>}
          </div>
          <div className={styles.approvalActions}>
            <Button icon={<MessageOutlined />} disabled={!canDecide} onClick={() => setCommentOpen(true)}>评论</Button>
            <Button danger icon={<CloseCircleOutlined />} loading={submitting} disabled={!canDecide}
              onClick={() => handleFinal('REJECTED')}>驳回</Button>
            <Button type="primary" icon={<CheckCircleOutlined />} loading={submitting} disabled={!canDecide}
              onClick={() => handleFinal('APPROVED')}>通过</Button>
          </div>
        </div>
      )}

      <div className={styles.body}>
        {/* 左：条款 */}
        <div className={styles.clausePanel}>
          <div className={styles.panelTitle}>合同条款（{clauses.length}）</div>
          <div className={styles.clauseList}>
            {clauses.map((c) => {
              const rs = clauseRiskMap[c.id] || []
              const high = rs.some((r) => r.severity === 'HIGH')
              return (
                <div
                  key={c.id}
                  className={`${styles.clauseItem} ${selectedClause === c.id ? styles.clauseActive : ''}`}
                  onClick={() => setSelectedClause(c.id)}
                >
                  <div className={styles.clauseHead}>
                    <span className={styles.clauseIdx}>{c.indexNo === 0 ? '前言' : `第${c.indexNo}条`}</span>
                    <Tag style={{ fontSize: 11 }}>{CLAUSE_TYPE_TEXT[c.clauseType] || c.clauseType}</Tag>
                    {rs.length > 0 && (
                      <Badge
                        count={rs.length} size="small"
                        color={high ? '#dc2626' : '#d97706'}
                        className={styles.riskBadge}
                      />
                    )}
                  </div>
                  <div className={styles.clauseTitle}>{c.title}</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* 中：风险卡片流 */}
        <div className={styles.riskPanel}>
          <div className={styles.riskToolbar}>
            <Segmented
              size="small"
              options={[
                { label: '全部', value: 'ALL' },
                { label: '高风险', value: 'HIGH' },
                { label: '中风险', value: 'MED' },
                { label: '低风险', value: 'LOW' },
              ]}
              value={sevFilter}
              onChange={setSevFilter}
            />
            <Input.Search
              size="small" allowClear placeholder="搜索风险标题/引用" style={{ width: 220 }}
              onSearch={setKeyword} onChange={(e) => !e.target.value && setKeyword('')}
            />
            <span className={styles.riskCount}>共 {filteredRisks.length} 项</span>
          </div>

          <div className={styles.riskList}>
            {(reviewing || reviewStages.length > 0 || reviewError) && (
              <div className={styles.runBox}>
                {reviewing && <Spin />}
                {reviewError && <div className={styles.errorBar}>审查启动失败：{reviewError}</div>}
                <div className={styles.stageList}>
                  {reviewStages.map((s, i) => (
                    <div key={i} className={styles.stageItem}>
                      <Badge status={i === reviewStages.length - 1 ? 'processing' : 'success'} text={s.message} />
                    </div>
                  ))}
                </div>
                {reviewStats && (
                  <div className={styles.statsLine}>
                    命中：高 {reviewStats.high} · 中 {reviewStats.med} · 低 {reviewStats.low}
                    ｜规则 {reviewStats.rule} · AI {reviewStats.agent} · 双轨 {reviewStats.both}
                  </div>
                )}
                {liveRisks.map((r) => (
                  <RiskCard key={r.id} risk={r} reviewOpen={false}
                    onSelectClause={() => {}} />
                ))}
              </div>
            )}

            {!reviewing && filteredRisks.length === 0 && (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={review ? '该审查未发现风险' : '尚未发起审查'}
              />
            )}

            {!reviewing && !isTeamSpace && filteredRisks.map((r) => (
              <div key={r.id} ref={(el) => { riskRefs.current[r.id] = el }}>
                <RiskCard
                  risk={r}
                  active={selectedClause && r.clauseId === selectedClause}
                  reviewOpen={reviewOpen && canDecide}
                  decision={decisions[r.id]}
                  onSelectClause={selectClauseAndScroll}
                  onDecision={decide}
                />
              </div>
            ))}

            {!reviewing && isTeamSpace && review && (
              <>
                {playbookRisks.length > 0 && (
                  <div className={styles.sectionHead}>
                    <SafetyCertificateFilled style={{ color: '#7c3aed' }} />
                    公司红线 / 偏好 · {playbookRisks.length} 项
                  </div>
                )}
                {playbookRisks.map((r) => (
                  <div key={r.id} ref={(el) => { riskRefs.current[r.id] = el }}>
                    <RiskCard
                      risk={r}
                      active={selectedClause && r.clauseId === selectedClause}
                      reviewOpen={reviewOpen && canDecide}
                      decision={decisions[r.id]}
                      onSelectClause={selectClauseAndScroll}
                      onDecision={decide}
                    />
                  </div>
                ))}
                {normalRisks.length > 0 && (
                  <div className={styles.sectionHead}>通用风险 · {normalRisks.length} 项</div>
                )}
                {normalRisks.map((r) => (
                  <div key={r.id} ref={(el) => { riskRefs.current[r.id] = el }}>
                    <RiskCard
                      risk={r}
                      active={selectedClause && r.clauseId === selectedClause}
                      reviewOpen={reviewOpen && canDecide}
                      decision={decisions[r.id]}
                      onSelectClause={selectClauseAndScroll}
                      onDecision={decide}
                    />
                  </div>
                ))}
              </>
            )}
          </div>

          {/* 企业态：AI 抽取结构化信息（无 Key 时整块隐藏） */}
          {isTeamSpace && (structured || structuredLoading) && (
            <div className={styles.structuredCard}>
              <div className={styles.structuredHead}>
                <span className={styles.structuredTitle}>结构化信息</span>
                <Tag color="purple">AI 抽取</Tag>
                {structured && (
                  <Tooltip title="按当前条款重新抽取">
                    <Button
                      type="text" size="small" icon={<RedoOutlined />}
                      loading={structuredLoading}
                      onClick={() => refreshStructured(true)}
                    />
                  </Tooltip>
                )}
              </div>
              {structuredLoading && !structured && (
                <div style={{ padding: '16px 0', textAlign: 'center' }}><Spin tip="AI 抽取中…" /></div>
              )}
              {structured && (
                <table className={styles.structuredTable}>
                  <tbody>
                    {structured.amounts?.map((a, i) => (
                      <tr key={`a${i}`}>
                        <th>{a.name || '金额项'}</th>
                        <td>
                          <span className={a.redline ? styles.amountRedline : ''}>{a.amount}</span>
                          {a.redline && <Tag color="red" style={{ marginLeft: 8 }}>红线</Tag>}
                          {a.note && <div className={styles.structuredNote}>{a.note}</div>}
                        </td>
                      </tr>
                    ))}
                    {(structured.term?.duration || structured.term?.description) && (
                      <tr>
                        <th>合同期限</th>
                        <td>
                          {[structured.term.duration, structured.term.startDate, structured.term.endDate]
                            .filter(Boolean).join(' · ')}
                          {structured.term.description && (
                            <div className={styles.structuredNote}>{structured.term.description}</div>
                          )}
                        </td>
                      </tr>
                    )}
                    {structured.paymentTerms && (
                      <tr>
                        <th>付款节点</th>
                        <td>{structured.paymentTerms}</td>
                      </tr>
                    )}
                    {structured.keyObligations?.length > 0 && (
                      <tr>
                        <th>关键义务</th>
                        <td>
                          {structured.keyObligations.map((o, i) => (
                            <div key={`o${i}`} className={styles.obligationItem}>· {o}</div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className={styles.sidePanel}>
          <div className={styles.panelTitle}>审查进程</div>

          {!review && !reviewing && (
            <div className={styles.sideHint}>
              <p>双轨审查流程：</p>
              <ol>
                <li>规则引擎确定性扫描（12 条内置规则，零成本保底）</li>
                <li>AI 语义分批审查（法规检索工具 + 原文引用校验）</li>
                <li>人工逐条终审（采纳 / 忽略 + 备注）</li>
                <li>生成审查意见书（Markdown，可打印导出）</li>
              </ol>
              {canDecide
                ? <Button type="primary" block icon={<PlayCircleOutlined />} onClick={handleStart}>发起 AI 审查</Button>
                : <Tooltip title="仅管理员/主管可发起审查"><Button block disabled icon={<PlayCircleOutlined />}>发起 AI 审查</Button></Tooltip>}
            </div>
          )}

          {reviewing && (
            <div className={styles.sideHint}>
              <Spin tip="审查进行中…" />
              {reviewError && <div className={styles.errorText}>{reviewError}</div>}
            </div>
          )}

          {review && !reviewing && (
            <>
              {stats && (
                <div className={styles.statGrid}>
                  <div><Statistic title="风险总数" value={stats.total} /></div>
                  <div><Statistic title="高" value={stats.high} valueStyle={{ color: '#dc2626' }} /></div>
                  <div><Statistic title="中" value={stats.med} valueStyle={{ color: '#d97706' }} /></div>
                  <div><Statistic title="低" value={stats.low} valueStyle={{ color: '#2563eb' }} /></div>
                </div>
              )}
              <Divider className={styles.sideDivider} />
              <div className={styles.sourceLine}>
                规则 {stats?.rule ?? 0} 项 · AI {stats?.agent ?? 0} 项 · 双轨确认 {stats?.both ?? 0} 项
              </div>

              {review.status === 'WAITING_REVIEW' && (
                <div className={styles.decideBox}>
                  <div className={styles.waitingTip}>
                    <Badge status="warning" text="等待人工终审" />
                  </div>
                  {canDecide ? (
                    <>
                      <div className={styles.decideHint}>在卡片上逐条「采纳 / 忽略」，也可直接整体判定：</div>
                      <Button
                        block type="primary" icon={<CheckCircleOutlined />}
                        loading={submitting} style={{ marginBottom: 8 }}
                        onClick={() => handleFinal('APPROVED')}
                      >
                        审查通过并生成意见书
                      </Button>
                      <Button
                        block danger icon={<CloseCircleOutlined />}
                        disabled={submitting}
                        onClick={() => handleFinal('REJECTED')}
                      >
                        驳回退回修改
                      </Button>
                    </>
                  ) : (
                    <div className={styles.decideHint}>当前角色无终审权限，请联系管理员/主管。</div>
                  )}
                </div>
              )}

              {review.status === 'APPROVED' && (
                <div className={styles.doneBox}>
                  <CheckCircleOutlined style={{ color: 'var(--color-success)', fontSize: 22 }} />
                  <div>审查通过{acceptedCount > 0 ? `，采纳 ${acceptedCount} 项` : ''}，意见书已归档</div>
                  <Button block icon={<FileSearchOutlined />} onClick={openReport}>查看意见书</Button>
                </div>
              )}

              {review.status === 'REJECTED' && (
                <div className={styles.doneBox}>
                  <CloseCircleOutlined style={{ color: 'var(--color-danger)', fontSize: 22 }} />
                  <div>已驳回，合同回到待审查状态</div>
                  <Button block type="primary" icon={<PlayCircleOutlined />} onClick={handleStart}>重新发起审查</Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 企业审批评论 */}
      <Modal
        title="审批评论"
        open={commentOpen}
        onCancel={() => setCommentOpen(false)}
        confirmLoading={commentSending}
        okText="提交评论"
        cancelText="取消"
        onOk={submitComment}
        destroyOnClose
      >
        <Input.TextArea
          rows={4} maxLength={500} showCount
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          placeholder="填写审批意见或要求法务补充核查的要点（评论将记录到审批日志，不改变审批状态）"
        />
      </Modal>

      {/* 意见书 Modal */}
      <Modal
        title="合同风险审查意见书"
        open={reportOpen}
        width={860}
        onCancel={() => setReportOpen(false)}
        footer={[
          <Button key="docx" icon={<FileWordOutlined />} loading={exportingReport} onClick={exportReportDocx}>导出 Word 意见书</Button>,
          <Button key="print" type="primary" icon={<PrinterOutlined />} onClick={printReport}>打印 / 另存 PDF</Button>,
          <Button key="close" onClick={() => setReportOpen(false)}>关闭</Button>,
        ]}
      >
        <div
          className={styles.reportMd}
          dangerouslySetInnerHTML={{ __html: reportHtml }}
        />
      </Modal>
    </div>
  )
}
