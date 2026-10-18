// frontend/src/views/contract/ReviewWorkbench.jsx
// 合同审查工作台：左条款（风险定位高亮）／中风险卡片流（终审处置）／右审查进程与结论（意见书）
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Button, Tag, Spin, Empty, Segmented, Modal, App, Statistic, Badge, Divider, Tooltip, Input, Dropdown,
  Select, Alert,
} from 'antd'
import {
  ArrowLeftOutlined, PlayCircleOutlined, FileSearchOutlined, PrinterOutlined,
  FileWordOutlined, HistoryOutlined, DownloadOutlined,
  CheckCircleOutlined, CloseCircleOutlined, ReloadOutlined, WarningOutlined,
  SafetyCertificateFilled, MessageOutlined, RedoOutlined, InfoCircleOutlined, EyeOutlined,
} from '@ant-design/icons'
import { useContractStore, CONTRACT_STATUS_META, SCENE_OPTIONS } from '@/stores/contract.js'
import { useAuthStore } from '@/stores/auth.js'
import { useMeStore } from '@/stores/me.js'
import http from '@/utils/http.js'
import { trackFirstResultSeen } from '@/utils/analytics.js'
import RiskCard from '@/components/contract/RiskCard.jsx'
import Paywall from '@/components/billing/Paywall.jsx'
import ArchiveDrawer from './ArchiveDrawer.jsx'
import styles from './ReviewWorkbench.module.css'

const CLAUSE_TYPE_TEXT = {
  PARTIES: '缔约信息', AMOUNT: '价款支付', TERM: '期限交付', BREACH: '违约责任',
  TERMINATION: '解除终止', GOVERNING_LAW: '争议解决', CONFIDENTIALITY: '保密条款',
  IP: '知识产权', OTHER: '其他',
}

const SCENE_TEXT = {
  LABOR: '劳动', INTERNSHIP: '实习', LEASE: '租赁', SERVICE: '劳务', NDA: '保密',
  SALE: '买卖', LOAN: '借款', EQUITY: '股权', CUSTOM: '非标',
}

// 「修订后新合同」导出格式：clean=已应用修改、无痕迹可直接定稿；redline=保留 Word 修订痕迹
const REVISION_EXPORT_MENU = [
  { key: 'docx-clean', label: 'Word 修订后合同（终版 · 可直接定稿）' },
  { key: 'docx-redline', label: 'Word 红划线修订稿（保留修订痕迹）' },
  { type: 'divider' },
  { key: 'pdf-clean', label: 'PDF 干净终版' },
  { key: 'pdf-redline', label: 'PDF 红划线版' },
]

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
    exportRevisionDocx, exportRevisionPdf, updateContract,
  } = useContractStore()

  const [selectedClause, setSelectedClause] = useState(null)
  const [sevFilter, setSevFilter] = useState('ALL')
  const [keyword, setKeyword] = useState('')
  const [decisions, setDecisions] = useState({})   // { [riskId]: { status, comment } }
  const [submitting, setSubmitting] = useState(false)
  const [reportMd, setReportMd] = useState('')
  const [reportHtml, setReportHtml] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [exportingReport, setExportingReport] = useState(false)
  const [exportingRev, setExportingRev] = useState('')
  const [sceneUpdating, setSceneUpdating] = useState(false)
  const [paywall, setPaywall] = useState(false) // 个人免费额度 PLAN_LIMIT 付费墙
  // 企业态：结构化信息卡 + 审批评论
  const [structured, setStructured] = useState(null)
  const [structuredLoading, setStructuredLoading] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [commentSending, setCommentSending] = useState(false)
  const riskRefs = useRef({})
  const resultSeenRef = useRef(false)
  const [previewBlobUrl, setPreviewBlobUrl] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)

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

  // 预览：带 auth 拉 blob → object URL（iframe 裸请求不带 token 会 401）
  useEffect(() => {
    if (!contract) return
    if (previewBlobUrl) { URL.revokeObjectURL(previewBlobUrl); setPreviewBlobUrl('') }
    if (!contract.storagePath) return // 粘贴文本合同用 clauses srcDoc 渲染
    setPreviewLoading(true)
    let cancelled = false
    http.get(`/contracts/${id}/preview`, { responseType: 'blob' })
      .then((blob) => {
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        setPreviewBlobUrl(url)
      })
      .catch((e) => {
        if (!cancelled) console.warn('preview fetch failed', e?.message)
      })
      .finally(() => { if (!cancelled) setPreviewLoading(false) })
    return () => { cancelled = true; if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl) }
  }, [id, contract?.storagePath]) // eslint-disable-line react-hooks/exhaustive-deps

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
  // 采纳口径与后端 acceptedEdits 对齐：逐条采纳（status=ACCEPTED）或改写已接受（revisionStatus=ACCEPTED）
  const acceptedCount = risks.filter((r) => r.status === 'ACCEPTED' || r.revisionStatus === 'ACCEPTED').length

  // 漏斗：风险清单生成（stats 落库）即视为「看到结果」，每会话只记一次
  useEffect(() => {
    if (stats && !resultSeenRef.current) {
      resultSeenRef.current = true
      trackFirstResultSeen(contract?.scene)
    }
  }, [stats, contract?.scene])

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

  // 修改合同类型（决定本次审查适用哪一类公司红线）；旧审查结果与归档保留，仅提示重新审查
  const handleSceneChange = async (scene) => {
    setSceneUpdating(true)
    try {
      const res = await updateContract(id, { scene })
      await loadDetail(id)
      const detected = res?.detected?.scene
      if (detected) {
        message.success(`已按 AI 识别结果更新为「${SCENE_TEXT[detected] || detected}」，建议重新发起审查`)
      } else if (scene === 'AUTO') {
        message.success('已切换为「自动识别（AI）」，解析完成后自动回填类型；建议重新发起审查')
      } else {
        message.success('合同类型已变更，建议重新发起审查')
      }
    } finally { setSceneUpdating(false) }
  }

  const handleStart = async () => {
    setDecisions({})
    const { blocked } = await startReview(id)
    if (blocked) setPaywall(true) // 免费额度用尽：弹付费墙（含深度券兜底）
    const d = useContractStore.getState().detail
    if (d?.review?.status === 'WAITING_REVIEW') message.success('规则扫描完成，等待人工终审')
  }

  const handleUseCoupon = async () => {
    setPaywall(false)
    await startReview(id, { payWithCoupon: true })
    const d = useContractStore.getState().detail
    if (d?.review?.status === 'WAITING_REVIEW') message.success('已使用深度券重新发起审查')
  }

  const decide = (riskId, patch) => {
    setDecisions((m) => ({ ...m, [riskId]: { ...m[riskId], ...patch } }))
  }

  // 保存用户手写的改写句 —— 调后端 + 刷新 detail（让 risk.rewritten / revisionStatus 更新）
  const handleSaveRewrite = async (riskId, rewritten) => {
    await http.post(`/risks/${riskId}/rewrite`, { rewritten })
    await loadDetail(id)
  }

  // AI 为单条风险生成改写（用改稿台的 regenerate，语气默认 NEUTRAL）
  const [generating, setGenerating] = useState(null)
  const handleGenerateRewrite = async (riskId) => {
    setGenerating(riskId)
    try {
      await http.post(`/risks/${riskId}/revision/regenerate`, { tone: 'NEUTRAL' })
      await loadDetail(id)
      message.success('AI 改写已生成，可在卡片里编辑调整')
    } catch (e) {
      message.error(e?.message || 'AI 改写生成失败')
    } finally {
      setGenerating(null)
    }
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

  // 导出「修订后新合同」（核心交付物）：把已采纳的修改点应用到原始文档，保留原版式
  const exportRevised = async (fmt) => {
    setExportingRev(fmt)
    try {
      if (fmt === 'docx-clean') await exportRevisionDocx(id, 'clean')
      else if (fmt === 'docx-redline') await exportRevisionDocx(id, 'redline')
      else if (fmt === 'pdf-clean') await exportRevisionPdf(id, 'clean')
      else await exportRevisionPdf(id, 'redline')
      message.success('已生成修订后合同')
    } catch (e) {
      message.warning(e?.status === 403
        ? (e.message || '当前套餐不支持导出，请升级套餐')
        : (e?.message || '导出失败：请先在风险卡片上采纳要修改的点'))
    } finally {
      setExportingRev('')
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
              {playbookTotal > 0 && (
                <Tag color="purple" style={{ marginLeft: 4 }}>
                  {isTeamSpace ? 'Playbook 命中' : '规则命中'} {playbookTotal} 条
                </Tag>
              )}
            </div>
            <div className={styles.subtitle}>
              {contract.fileName} · {contract.clausesCount} 条 · {contract.charCount} 字
            </div>
            <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>合同类型</span>
              <Select
                size="small"
                style={{ width: 168 }}
                value={contract.sceneSource === 'AUTO' ? 'AUTO' : contract.scene}
                options={SCENE_OPTIONS}
                loading={sceneUpdating}
                disabled={sceneUpdating || reviewing}
                onChange={handleSceneChange}
              />
            </div>
          </div>
        </div>
        <div className={styles.headerRight}>
          {acceptedCount > 0 && (
            <Dropdown
              trigger={['click']}
              menu={{ items: REVISION_EXPORT_MENU, onClick: ({ key }) => exportRevised(key) }}
            >
              <Button type="primary" icon={<DownloadOutlined />} loading={!!exportingRev}>导出修订后合同</Button>
            </Dropdown>
          )}
          <Button icon={<HistoryOutlined />} onClick={() => setArchiveOpen(true)}>文档归档</Button>
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

      {/* AI 识别出的付费类型套餐未支持：本次仅通用规则审查，提示升级启用专项红线 */}
      {review?.stats?.sceneNotice && (
        <Alert
          type="warning" showIcon icon={<InfoCircleOutlined />}
          style={{ margin: '0 0 12px' }}
          message={review.stats.sceneNotice}
        />
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
        {/* 左：合同原件预览 */}
        <div className={styles.clausePanel}>
          <div className={styles.previewToolbar}>
            <EyeOutlined style={{ color: 'var(--color-primary)' }} />
            <span className={styles.previewTitle}>合同原件预览</span>
            {contract?.storagePath && (
              <Button
                type="link" size="small" style={{ padding: 0, height: 'auto' }}
                onClick={() => { previewBlobUrl && window.open(previewBlobUrl, '_blank') }}
              >新窗口</Button>
            )}
          </div>
          {previewLoading && <div className={styles.previewEmpty}><Spin tip="加载预览中…" /></div>}
          {!previewLoading && contract?.storagePath && previewBlobUrl && (
            <iframe className={styles.previewFrame} src={previewBlobUrl} title="合同原件预览" />
          )}
          {!previewLoading && contract?.storagePath && !previewBlobUrl && (
            <div className={styles.previewEmpty}>预览加载失败</div>
          )}
          {/* 粘贴文本合同：用已解析的 clauses 渲染原文 */}
          {!contract?.storagePath && clauses.length > 0 && (
            <iframe
              className={styles.previewFrame}
              title="合同原文"
              srcDoc={(() => {
                const esc = (s) => String(s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
                const body = clauses.map((c) =>
                  `<div style="margin-bottom:18px">
                    <h4 style="margin:0 0 6px 0;font-size:14px;color:#111">${c.indexNo === 0 ? '前言' : `第${c.indexNo}条`} · ${esc(c.title || '')}</h4>
                    <p style="margin:0;line-height:1.8;color:#333;white-space:pre-wrap">${esc(c.content)}</p>
                  </div>`,
                ).join('')
                return `<!doctype html><html><head><meta charset="utf-8">
<style>body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;max-width:800px;margin:0 auto;padding:24px;font-size:14px;color:#111}</style>
</head><body>${body}</body></html>`
              })()}
            />
          )}
          {!contract?.storagePath && clauses.length === 0 && (
            <div className={styles.previewEmpty}>
              <div>尚未解析出合同条款</div>
            </div>
          )}
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
                    <div key={i}>
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
                {/* 直播卡片仅在审查进行中展示；完成后由下方正式列表（带采纳/忽略/AI改写）接管，避免无操作卡片遮挡 */}
                {reviewing && liveRisks.map((r) => (
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

            {!reviewing && filteredRisks.length > 0 && !review && filteredRisks.map((r) => (
              <div key={r.id} ref={(el) => { riskRefs.current[r.id] = el }}>
                <RiskCard
                  risk={r}
                  active={selectedClause && r.clauseId === selectedClause}
                  reviewOpen={!!review && !reviewing}
                  decision={decisions[r.id]}
                  onSelectClause={selectClauseAndScroll}
                  onDecision={decide}
                  onSaveRewrite={handleSaveRewrite}
                  onGenerateRewrite={handleGenerateRewrite}
                  generating={generating === r.id}
                />
              </div>
            ))}

            {!reviewing && review && (
              <>
                {playbookRisks.length > 0 && (
                  <div className={styles.sectionHead}>
                    <SafetyCertificateFilled style={{ color: '#7c3aed' }} />
                    {isTeamSpace ? '公司红线 / 偏好' : '我的规则命中'} · {playbookRisks.length} 项
                  </div>
                )}
                {playbookRisks.map((r) => (
                  <div key={r.id} ref={(el) => { riskRefs.current[r.id] = el }}>
                    <RiskCard
                      risk={r}
                      active={selectedClause && r.clauseId === selectedClause}
                      reviewOpen={!!review && !reviewing}
                      decision={decisions[r.id]}
                      onSelectClause={selectClauseAndScroll}
                      onDecision={decide}
                      onSaveRewrite={handleSaveRewrite}
                      onGenerateRewrite={handleGenerateRewrite}
                      generating={generating === r.id}
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
                      reviewOpen={!!review && !reviewing}
                      decision={decisions[r.id]}
                      onSelectClause={selectClauseAndScroll}
                      onDecision={decide}
                      onSaveRewrite={handleSaveRewrite}
                      onGenerateRewrite={handleGenerateRewrite}
                      generating={generating === r.id}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
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
                  {acceptedCount > 0 && (
                    <Dropdown
                      trigger={['click']}
                      menu={{ items: REVISION_EXPORT_MENU, onClick: ({ key }) => exportRevised(key) }}
                    >
                      <Button block type="primary" icon={<DownloadOutlined />} loading={!!exportingRev}>
                        导出修订后合同
                      </Button>
                    </Dropdown>
                  )}
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

      <ArchiveDrawer
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        contractId={id}
        contractTitle={contract.title}
        reviewTaskId={review?.id}
      />

      {/* 个人免费额度用尽付费墙（PLAN_LIMIT） */}
      <Paywall
        open={paywall}
        onClose={() => setPaywall(false)}
        couponBalance={entitlement?.couponBalance ?? 0}
        source="review_workbench"
        onUseCoupon={handleUseCoupon}
      />
    </div>
  )
}
