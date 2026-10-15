// frontend/src/views/platform/PlatformEvalTab.jsx
// 超管控制台 · 离线评测报告：EvalRun 列表（commit / 通过率 / 分组指标）→ 抽屉查看 EvalResult 明细。
// EvalRun 是平台基线数据（无租户维度），接口走 /api/platform/eval-runs（PLATFORM_ADMIN 鉴权）。
import { useCallback, useEffect, useState } from 'react'
import {
  Button, Table, Tag, Drawer, Spin, Empty, Typography, Space, Statistic, Row, Col, App as AntApp,
} from 'antd'
import { ReloadOutlined, CheckCircleFilled, CloseCircleFilled } from '@ant-design/icons'
import platformApi, { platformErrMessage } from '@/utils/platformApi.js'

const { Text } = Typography

const TYPE_LABEL = {
  RISK_DETECT: '风险检出',
  RAG_RECALL: '法规检索',
  FAITHFULNESS: '忠实度',
}

function fmtDateTime(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`
}

function shortSha(sha) {
  return sha ? sha.slice(0, 8) : '-'
}

export default function PlatformEvalTab() {
  const { message } = AntApp.useApp()
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [activeId, setActiveId] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await platformApi.get('/eval-runs', { params: { page, pageSize: 10 } })
      setData(d)
    } catch (err) {
      message.error(platformErrMessage(err, '评测记录加载失败'))
    } finally {
      setLoading(false)
    }
  }, [page, message])

  useEffect(() => { load() }, [load])

  const columns = [
    {
      title: '状态', dataIndex: 'status', width: 80,
      render: (s) => {
        const map = { DONE: ['green', '完成'], RUNNING: ['blue', '运行中'], FAILED: ['red', '失败'] }
        const [color, text] = map[s] || ['default', s]
        return <Tag color={color}>{text}</Tag>
      },
    },
    { title: '开始时间', dataIndex: 'startedAt', width: 160, render: fmtDateTime },
    { title: 'Commit', dataIndex: 'commitSha', width: 100, render: (sha) => <Text code>{shortSha(sha)}</Text> },
    {
      title: '通过率', width: 110,
      render: (_, row) => {
        const rate = row.caseCount ? row.passCount / row.caseCount : 0
        const color = rate >= 0.95 ? '#16a34a' : rate >= 0.8 ? '#d97706' : '#dc2626'
        return <span style={{ color, fontWeight: 600 }}>{row.passCount}/{row.caseCount}（{pct(rate)}）</span>
      },
    },
    { title: '分组指标', render: (_, row) => <GroupMetrics summary={row.summary} /> },
    {
      title: '操作', width: 90,
      render: (_, row) => (
        <Button type="link" size="small" onClick={(e) => { e.stopPropagation(); setActiveId(row.id) }}>查看明细</Button>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>离线评测报告</h2>
        <Button size="small" icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </div>

      <Spin spinning={loading}>
        <Table
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={data.items}
          pagination={{
            current: page, pageSize: 10, total: data.total, showSizeChanger: false, onChange: setPage,
          }}
          onRow={(row) => ({ onClick: () => setActiveId(row.id), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty description="还没有评测记录，先在 server 目录执行 npm run eval" /> }}
        />
      </Spin>

      <Drawer
        title="评测明细"
        placement="right"
        width={860}
        open={!!activeId}
        onClose={() => setActiveId(null)}
        destroyOnClose
      >
        {activeId && <EvalRunDetail runId={activeId} />}
      </Drawer>
    </div>
  )
}

/** 列表行内的分组指标摘要 */
function GroupMetrics({ summary }) {
  const groups = summary?.groups
  if (!groups) return <Text type="secondary">-</Text>
  const chips = []
  if (groups.RISK_DETECT?.status === 'done') {
    chips.push(<Tag key="risk" color="geekblue">风险 F1 {pct(groups.RISK_DETECT.f1)}</Tag>)
  }
  if (groups.RAG_RECALL?.status === 'done') {
    chips.push(<Tag key="rag" color="green">recall@3 {pct(groups.RAG_RECALL.recallAtK)}</Tag>)
  }
  if (groups.FAITHFULNESS?.status === 'done') {
    chips.push(<Tag key="faith" color="purple">忠实度 {pct(groups.FAITHFULNESS.accuracy)}</Tag>)
  } else if (groups.FAITHFULNESS?.status === 'skipped') {
    chips.push(<Tag key="faith">忠实度跳过</Tag>)
  }
  return <Space size={4} wrap>{chips}</Space>
}

function EvalRunDetail({ runId }) {
  const { message } = AntApp.useApp()
  const [detail, setDetail] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    platformApi.get(`/eval-runs/${runId}`)
      .then((d) => { if (alive) setDetail(d) })
      .catch((err) => message.error(platformErrMessage(err, '评测明细加载失败')))
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [runId, message])

  if (loading) return <Spin style={{ display: 'block', marginTop: 80 }} />
  if (!detail) return <Empty description="记录不可用" style={{ marginTop: 80 }} />

  const { run, results } = detail
  const g = run.summary?.groups || {}

  const resultColumns = [
    {
      title: '', dataIndex: 'passed', width: 32,
      render: (ok) => ok
        ? <CheckCircleFilled style={{ color: '#16a34a' }} />
        : <CloseCircleFilled style={{ color: '#dc2626' }} />,
    },
    {
      title: '分组', width: 88,
      render: (_, r) => <Tag>{TYPE_LABEL[r.case?.type] || r.case?.type}</Tag>,
    },
    {
      title: '用例',
      render: (_, r) => (
        <div>
          <div style={{ fontWeight: r.passed ? 400 : 600 }}>{r.case?.title}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>{r.judgeReason}</Text>
        </div>
      ),
    },
    { title: '得分', dataIndex: 'score', width: 72, align: 'right', render: (v) => v.toFixed(2) },
    { title: '耗时', dataIndex: 'latencyMs', width: 72, align: 'right', render: (v) => `${v}ms` },
  ]

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Text code>{shortSha(run.commitSha)}</Text>
        <Tag color={run.status === 'DONE' ? 'green' : run.status === 'FAILED' ? 'red' : 'blue'}>{run.status}</Tag>
        <Text type="secondary">{fmtDateTime(run.startedAt)}</Text>
      </Space>

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Statistic title="总通过率" value={pct(run.caseCount ? run.passCount / run.caseCount : 0)} />
        </Col>
        <Col span={6}>
          <Statistic title="风险检出 F1" value={g.RISK_DETECT?.status === 'done' ? pct(g.RISK_DETECT.f1) : '-'} />
        </Col>
        <Col span={6}>
          <Statistic title="检索 recall@3" value={g.RAG_RECALL?.status === 'done' ? pct(g.RAG_RECALL.recallAtK) : '-'} />
        </Col>
        <Col span={6}>
          <Statistic title="忠实度一致率" value={g.FAITHFULNESS?.status === 'done' ? pct(g.FAITHFULNESS.accuracy) : '跳过'} />
        </Col>
      </Row>

      <Table
        rowKey="id"
        size="small"
        columns={resultColumns}
        dataSource={results}
        pagination={false}
        rowClassName={(r) => (r.passed ? '' : 'eval-row-failed')}
        expandable={{
          expandedRowRender: (r) => <ResultDiff result={r} />,
          rowExpandable: () => true,
        }}
      />
    </div>
  )
}

/** 展开行：actual vs expected 关键差异 */
function ResultDiff({ result }) {
  const actual = result.actual || {}
  const expected = result.case?.expected || {}

  let rows = null
  if (result.case?.type === 'RISK_DETECT') {
    const code = (arr) => (arr?.length ? arr.join(', ') : '（空）')
    rows = (
      <>
        <DiffLine label="期望命中" value={code(expected.ruleCodes)} ok />
        <DiffLine label="实际命中" value={code(actual.actualCodes)} ok />
        <DiffLine label="误报 FP" value={code(actual.fp)} bad={actual.fp?.length > 0} />
        <DiffLine label="漏报 FN" value={code(actual.fn)} bad={actual.fn?.length > 0} />
      </>
    )
  } else if (result.case?.type === 'RAG_RECALL') {
    rows = (
      <>
        <DiffLine label="期望文档" value={(expected.docIds || []).join(', ')} ok />
        <DiffLine
          label="实际召回"
          value={(actual.retrieved || []).map((d) => `${d.docId}(${d.mode})`).join(', ') || '（空）'}
          bad={!result.passed}
        />
      </>
    )
  } else {
    rows = (
      <>
        <DiffLine label="标注忠实度" value={String(expected.faithful)} ok />
        <DiffLine label="Judge 打分" value={String(actual.judge)} bad={!result.passed} />
      </>
    )
  }

  return (
    <div style={{ padding: '4px 8px', background: '#f5f6fa', borderRadius: 6, fontSize: 13 }}>
      {rows}
    </div>
  )
}

function DiffLine({ label, value, ok, bad }) {
  const color = bad ? '#dc2626' : ok ? '#111827' : '#6b7280'
  return (
    <div style={{ display: 'flex', gap: 12, padding: '2px 0' }}>
      <span style={{ width: 80, flexShrink: 0, color: '#6b7280' }}>{label}</span>
      <span style={{ color, fontWeight: bad ? 600 : 400 }}>{value}</span>
    </div>
  )
}
