// frontend/src/views/monitor/TraceWaterfall.jsx
// Trace 瀑布页：左侧链路列表（feature/耗时/token/费用/状态），右侧 span 时间轴瀑布
// （LLM 靛蓝 / TOOL 琥珀 / RETRIEVER 翠绿），点击 span 展开 input/output JSON。
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Select, Table, Tag, Spin, Empty, Tooltip, Typography, Space, Statistic, Row, Col,
} from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined, CheckCircleFilled, CloseCircleFilled,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import styles from './TraceWaterfall.module.css'

const { Text } = Typography

const FEATURE_OPTIONS = [
  { value: '', label: '全部功能' },
  { value: 'chat', label: '对话助手' },
  { value: 'knowledge', label: 'RAG 知识库' },
  { value: 'agent', label: '任务 Agent' },
  { value: 'contract_review', label: '合同审查' },
  { value: 'eval', label: '离线评测' },
]

const FEATURE_LABEL = Object.fromEntries(FEATURE_OPTIONS.map((f) => [f.value, f.label]))

const SPAN_META = {
  LLM: { color: '#4f46e5', label: 'LLM' },
  TOOL: { color: '#f59e0b', label: '工具' },
  RETRIEVER: { color: '#10b981', label: '检索' },
}

function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function StatusIcon({ status }) {
  return status === 'OK'
    ? <CheckCircleFilled style={{ color: 'var(--color-success)' }} />
    : <CloseCircleFilled style={{ color: 'var(--color-danger)' }} />
}

export default function TraceWaterfall() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [feature, setFeature] = useState('')
  const [status, setStatus] = useState('')
  const [selectedId, setSelectedId] = useState(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const d = await http.get('/monitor/traces', {
        params: { page, pageSize: 20, feature: feature || undefined, status: status || undefined },
      })
      setData(d)
      if (d.items.length && (!selectedId || !d.items.some((x) => x.id === selectedId))) {
        setSelectedId(d.items[0].id)
      }
      if (!d.items.length) setSelectedId(null)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, feature, status])

  useEffect(() => { loadList() }, [loadList])

  const columns = [
    {
      title: '', dataIndex: 'status', width: 28,
      render: (s) => <StatusIcon status={s} />,
    },
    {
      title: '功能', dataIndex: 'feature', width: 92,
      render: (f) => <Tag style={{ marginInlineEnd: 0 }}>{FEATURE_LABEL[f] || f}</Tag>,
    },
    {
      title: '链路', dataIndex: 'name', ellipsis: true,
      render: (text, row) => (
        <div style={{ lineHeight: 1.3 }}>
          <div style={{ fontSize: 13 }}>{text}</div>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {fmtDateTime(row.createdAt)} · {row.latencyMs}ms · {row.tokens} tok · ¥{row.costCny.toFixed(4)}
          </Text>
        </div>
      ),
    },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <Space>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/monitor')}>返回看板</Button>
          <h2 className={styles.title}>调用链路瀑布</h2>
        </Space>
        <Space>
          <Select
            size="small" value={feature} onChange={(v) => { setPage(1); setFeature(v) }}
            options={FEATURE_OPTIONS} style={{ width: 130 }}
          />
          <Select
            size="small" value={status} onChange={(v) => { setPage(1); setStatus(v) }}
            style={{ width: 110 }}
            options={[
              { value: '', label: '全部状态' },
              { value: 'OK', label: '成功' },
              { value: 'ERROR', label: '失败' },
            ]}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={loadList}>刷新</Button>
        </Space>
      </div>

      <div className={styles.body}>
        <div className={styles.listPane}>
          <Spin spinning={loading}>
            <Table
              size="small"
              rowKey="id"
              columns={columns}
              dataSource={data.items}
              pagination={{
                current: page, pageSize: 20, total: data.total, size: 'small',
                showSizeChanger: false, onChange: setPage,
              }}
              onRow={(row) => ({
                onClick: () => setSelectedId(row.id),
                className: row.id === selectedId ? styles.rowActive : '',
              })}
              locale={{ emptyText: <Empty description="暂无链路" /> }}
            />
          </Spin>
        </div>
        <div className={styles.detailPane}>
          {selectedId
            ? <TraceDetail traceId={selectedId} />
            : <Empty description="选择左侧链路查看瀑布" style={{ marginTop: 120 }} />}
        </div>
      </div>
    </div>
  )
}

function TraceDetail({ traceId }) {
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setExpanded(null)
    http.get(`/monitor/traces/${traceId}`)
      .then((d) => { if (alive) setDetail(d) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [traceId])

  if (loading) return <Spin style={{ display: 'block', marginTop: 120 }} />
  if (!detail) return <Empty description="链路详情不可用" style={{ marginTop: 120 }} />

  const spans = detail.spans || []
  const base = spans.length ? new Date(spans[0].startedAt).getTime() : Date.now()
  const end = spans.reduce((mx, s) => Math.max(mx, new Date(s.startedAt).getTime() + s.durationMs), base)
  const totalMs = Math.max(end - base, 1)

  return (
    <div>
      <Row gutter={16} className={styles.summaryRow}>
        <Col span={8}>
          <Statistic title="总耗时" value={detail.latencyMs} suffix="ms" />
        </Col>
        <Col span={8}>
          <Statistic
            title="Token"
            value={detail.inputTokens + detail.outputTokens}
            suffix={`（入 ${detail.inputTokens} / 出 ${detail.outputTokens}）`}
            valueStyle={{ fontSize: 20 }}
          />
        </Col>
        <Col span={8}>
          <Statistic title="费用" value={detail.costCny.toFixed(4)} prefix="¥" />
        </Col>
      </Row>

      <div className={styles.metaLine}>
        <Tag color={detail.status === 'OK' ? 'green' : 'red'}>{detail.status}</Tag>
        <Tag>{FEATURE_LABEL[detail.feature] || detail.feature}</Tag>
        <Text type="secondary">{detail.name}</Text>
        {detail.model && <Tag>{detail.model}</Tag>}
      </div>
      {detail.error && (
        <div className={styles.errorBox}>{detail.error}</div>
      )}

      {spans.length === 0
        ? <Empty description="该链路没有 span（规则轨/缓存命中为纯本地计算）" style={{ marginTop: 60 }} />
        : (
          <div className={styles.timeline}>
            <div className={styles.axisHint}>
              <span>0ms</span>
              <span>{totalMs}ms（共 {spans.length} 个 span）</span>
            </div>
            {spans.map((s) => {
              const start = new Date(s.startedAt).getTime() - base
              const widthPct = Math.max((s.durationMs / totalMs) * 100, s.durationMs > 0 ? 0.6 : 0.3)
              const meta = SPAN_META[s.type] || { color: '#9ca3af', label: s.type }
              const isOpen = expanded === s.id
              return (
                <div key={s.id} className={styles.spanRow}>
                  <Tooltip title="点击展开 input/output">
                    <div className={styles.spanTrack} onClick={() => setExpanded(isOpen ? null : s.id)}>
                      <div
                        className={styles.spanBar}
                        style={{
                          marginLeft: `${(start / totalMs) * 100}%`,
                          width: `${Math.min(widthPct, 100 - (start / totalMs) * 100)}%`,
                          background: meta.color,
                        }}
                      />
                    </div>
                  </Tooltip>
                  <div className={styles.spanLabel}>
                    <Tag color={meta.color} style={{ marginInlineEnd: 6 }}>{meta.label}</Tag>
                    <span className={styles.spanName}>{s.name}</span>
                    <span className={styles.spanTime}>+{start}ms / {s.durationMs}ms</span>
                  </div>
                  {isOpen && <SpanPayload span={s} />}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

function SpanPayload({ span }) {
  const blocks = [
    { title: 'Input', value: span.input },
    { title: 'Output', value: span.output },
    span.metadata ? { title: 'Metadata', value: span.metadata } : null,
  ].filter(Boolean)

  return (
    <div className={styles.payload}>
      {(span.inputTokens || span.outputTokens) > 0 && (
        <Text type="secondary" style={{ marginRight: 16 }}>
          tokens：入 {span.inputTokens} / 出 {span.outputTokens} · ¥{Number(span.costCny).toFixed(4)}
        </Text>
      )}
      {blocks.map((b) => (
        <div key={b.title} className={styles.payloadBlock}>
          <div className={styles.payloadTitle}>{b.title}</div>
          <pre className={styles.json}>{JSON.stringify(b.value, null, 2)}</pre>
        </div>
      ))}
    </div>
  )
}
