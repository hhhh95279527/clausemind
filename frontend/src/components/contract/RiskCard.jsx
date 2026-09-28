// frontend/src/components/contract/RiskCard.jsx
// 单条风险卡片：严重度/来源/原文引用/分析/建议/法条 + 终审处置操作
import { Tag, Button, Input, Tooltip } from 'antd'
import {
  CheckOutlined, CloseOutlined, RobotOutlined, FilterOutlined, ApiOutlined, SafetyCertificateFilled,
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
  risk, active, reviewOpen, decision, onSelectClause, onDecision,
}) {
  const sevColor = SEVERITY_COLOR[risk.severity] || SEVERITY_COLOR.MED
  const baseSource = SOURCE_META[risk.detectedBy] || SOURCE_META.RULE
  // Playbook 偏好口径规则与红线规则区分标签文案
  const source = risk.detectedBy === 'PLAYBOOK' && risk.category === '偏好口径'
    ? { ...baseSource, text: '公司偏好' }
    : baseSource
  const chosen = decision?.status
  const finalized = risk.status && risk.status !== 'PENDING'

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
      </div>

      <div className={styles.meta}>
        <span>条款：{risk.clauseTitle || '—'}</span>
        <span>分类：{risk.category}</span>
      </div>

      <blockquote className={styles.quote}>{risk.quote}</blockquote>
      <div className={styles.section}><b>风险分析：</b>{risk.analysis}</div>
      {risk.suggestion && <div className={styles.section}><b>修改建议：</b>{risk.suggestion}</div>}
      {risk.legalBasis && <div className={styles.basis}><b>法律依据：</b>{risk.legalBasis}</div>}

      {finalized
        ? risk.reviewerComment && <div className={styles.finalComment}>终审备注：{risk.reviewerComment}</div>
        : reviewOpen && (
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
            </div>
            <Input
              size="small"
              placeholder="终审备注（可选）"
              value={chosen ? (decision?.comment || '') : ''}
              disabled={!chosen}
              onChange={(e) => onDecision(risk.id, { status: chosen || 'ACCEPTED', comment: e.target.value })}
            />
          </div>
        )}
    </div>
  )
}
