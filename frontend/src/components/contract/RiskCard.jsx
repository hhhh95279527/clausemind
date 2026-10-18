// frontend/src/components/contract/RiskCard.jsx
// 单条风险卡片：严重度/来源/原文引用/风险分析/修改建议/修改后的示例（可编辑）+ 终审处置
import { Tag, Button, Input, Tooltip, message } from 'antd'
import { useState, useEffect } from 'react'
import {
  CheckOutlined, CloseOutlined, RobotOutlined, FilterOutlined, ApiOutlined, SafetyCertificateFilled,
  EditOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import {
  SEVERITY_COLOR, SEVERITY_TEXT, RISK_STATUS_META,
} from '@/stores/contract.js'
import styles from './RiskCard.module.css'

const SOURCE_META = {
  RULE:     { color: 'blue',     text: '规则引擎', icon: <FilterOutlined /> },
  AGENT:    { color: 'purple',   text: 'AI 语义', icon: <RobotOutlined /> },
  BOTH:     { color: 'geekblue', text: '双轨确认', icon: <ApiOutlined /> },
  PLAYBOOK: { color: 'red',      text: '公司红线', icon: <SafetyCertificateFilled /> },
}

export default function RiskCard({
  risk, active, reviewOpen, decision,
  onSelectClause, onDecision, onSaveRewrite, onGenerateRewrite,
}) {
  const sevColor = SEVERITY_COLOR[risk.severity] || SEVERITY_COLOR.MED
  const baseSource = SOURCE_META[risk.detectedBy] || SOURCE_META.RULE
  const source = risk.detectedBy === 'PLAYBOOK' && risk.category === '偏好口径'
    ? { ...baseSource, text: '公司偏好' }
    : baseSource
  const chosen = decision?.status
  const finalized = risk.status && risk.status !== 'PENDING'

  // 改写草稿：只回显后端已经存过的 rewritten（AI 生成过 / 用户之前保存过），不回填 suggestion
  const [draft, setDraft] = useState(risk.rewritten || '')
  const [saving, setSaving] = useState(false)

  // risk 切换时同步草稿（从父级传入的 risk 可能变了）
  useEffect(() => {
    setDraft(risk.rewritten || '')
  }, [risk.id, risk.rewritten])

  const isRewriteAccepted = risk.revisionStatus === 'ACCEPTED'

  // 采纳改写：把当前草稿写回后端（即使用户没改，也存一份）
  const handleAcceptRewrite = async () => {
    if (!draft.trim()) {
      message.warning('请先填写修改后的示例')
      return
    }
    setSaving(true)
    try {
      await onSaveRewrite?.(risk.id, draft.trim())
      message.success('已采纳，修订稿将使用你的版本')
    } catch (e) {
      message.error(e?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={`${styles.card} ${active ? styles.active : ''}`}
      style={{ borderLeftColor: sevColor }}
      onClick={() => risk.clauseId && onSelectClause?.(risk.clauseId)}
    >
      <div className={styles.head}>
        <span className={styles.sevDot} style={{ background: sevColor }} />
        <span className={styles.title}>{risk.title}</span>
        <Tag color={sevColor === SEVERITY_COLOR.HIGH ? 'red' : sevColor === SEVERITY_COLOR.MED ? 'orange' : 'blue'}>
          {SEVERITY_TEXT[risk.severity] || risk.severity}
        </Tag>
        <Tag icon={source.icon} color={source.color}>{source.text}</Tag>
        {finalized && <Tag>{RISK_STATUS_META[risk.status]?.text || risk.status}</Tag>}
        {isRewriteAccepted && <Tag color="green" icon={<CheckOutlined />}>改写已采纳</Tag>}
      </div>

      <div className={styles.meta}>
        <span>条款：{risk.clauseTitle || '—'}</span>
        <span>分类：{risk.category}</span>
      </div>

      <blockquote className={styles.quote}>{risk.quote}</blockquote>

      {/* 风险分析 */}
      <div className={styles.section}><b>风险分析：</b>{risk.analysis}</div>

      {/* 修改建议 */}
      {risk.suggestion && (
        <div className={styles.section}><b>修改建议：</b>{risk.suggestion}</div>
      )}

      {/* 修改后的示例（可编辑） */}
      <div className={styles.rewriteBlock} onClick={(e) => e.stopPropagation()}>
        <div className={styles.rewriteHead}>
          <b><EditOutlined /> 修改后的示例：</b>
          {!risk.rewritten && (
            <Button
              size="small" type="link" icon={<ThunderboltOutlined />}
              onClick={() => onGenerateRewrite?.(risk.id)}
            >AI 生成改写</Button>
          )}
        </div>
        <Input.TextArea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="手写你希望替换进合同的最终条款文本，或点击右上「AI 生成改写」"
          autoSize={{ minRows: 2, maxRows: 6 }}
          className={styles.rewriteInput}
        />
        <div className={styles.rewriteFoot}>
          {isRewriteAccepted && <span style={{ color: 'var(--color-success)', fontSize: 12 }}>✓ 已保存，导出修订稿时将使用此版本</span>}
          {!isRewriteAccepted && draft.trim() && <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>编辑后点「采纳」保存到修订稿</span>}
        </div>
      </div>

      {risk.legalBasis && <div className={styles.basis}><b>法律依据：</b>{risk.legalBasis}</div>}

      {finalized && risk.reviewerComment && (
        <div className={styles.finalComment}>终审备注：{risk.reviewerComment}</div>
      )}

      {reviewOpen && (
        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          <div className={styles.actionBtns}>
            <Tooltip title="采纳该风险，写入意见书">
              <Button
                size="small" type={chosen === 'ACCEPTED' ? 'primary' : 'default'}
                icon={<CheckOutlined />}
                onClick={() => onDecision(risk.id, { status: 'ACCEPTED', comment: decision?.comment || '' })}
              >
                采纳
              </Button>
            </Tooltip>
            <Tooltip title="评估后忽略（不写入意见书采纳项）">
              <Button
                size="small" danger={chosen === 'IGNORED'}
                type={chosen === 'IGNORED' ? 'primary' : 'default'}
                icon={<CloseOutlined />}
                onClick={() => onDecision(risk.id, { status: 'IGNORED', comment: decision?.comment || '' })}
              >
                忽略
              </Button>
            </Tooltip>
            {/* 保存改写：把当前 TextArea 内容写进 risk.rewritten + revisionStatus=ACCEPTED */}
            <Button
              size="small" type="primary" ghost
              icon={<CheckOutlined />}
              loading={saving}
              disabled={!draft.trim()}
              onClick={handleAcceptRewrite}
            >
              采纳此改写
            </Button>
          </div>
          <Input
            size="small"
            placeholder="终审备注（可选）"
            value={chosen ? (decision?.comment || '') : ''}
            onChange={(e) => onDecision(risk.id, { status: chosen || 'ACCEPTED', comment: e.target.value })}
          />
        </div>
      )}
    </div>
  )
}
