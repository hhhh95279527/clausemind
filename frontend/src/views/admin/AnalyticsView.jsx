// frontend/src/views/admin/AnalyticsView.jsx
// 埋点漏斗看板（FR-26）：6 步转化漏斗 + persona/plan/scene 维度下钻
// 数据源：GET /api/admin/analytics/funnel、/breakdown（ADMIN）
// 原始事件见 analytics_events 表；本页只做聚合展示
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Card, DatePicker, Empty, Progress, Segmented, Spin, Table, Tag, Typography, Space,
} from 'antd'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import http from '@/utils/http.js'

const { RangePicker } = DatePicker
const { Text } = Typography

// 转化漏斗六步（顺序与后端 FUNNEL_STEPS 一致，不可调整）
const FUNNEL = [
  { step: 'sign_up', label: '注册' },
  { step: 'first_review_start', label: '首次发起审查' },
  { step: 'first_result_seen', label: '首次看到结果' },
  { step: 'paywall_show', label: '付费墙曝光' },
  { step: 'paywall_click_upgrade', label: '点击升级' },
  { step: 'checkout_success', label: '支付成功' },
]

const DIM_OPTIONS = [
  { label: '角色 persona', value: 'persona' },
  { label: '套餐 plan', value: 'plan' },
  { label: '场景 scene', value: 'scene' },
]

function pct(x) {
  return x == null ? '-' : `${(x * 100).toFixed(1)}%`
}

export default function AnalyticsView() {
  const navigate = useNavigate()
  const [range, setRange] = useState([dayjs().subtract(30, 'day'), dayjs()])
  const [funnel, setFunnel] = useState(null)
  const [dim, setDim] = useState('persona')
  const [breakdown, setBreakdown] = useState(null)
  const [loadingFunnel, setLoadingFunnel] = useState(false)
  const [loadingBreakdown, setLoadingBreakdown] = useState(false)

  const rangeParams = useCallback(() => {
    const [from, to] = range || []
    return { from: from?.toISOString(), to: to?.toISOString() }
  }, [range])

  const loadFunnel = useCallback(async () => {
    setLoadingFunnel(true)
    try {
      const d = await http.get('/admin/analytics/funnel', { params: rangeParams() })
      setFunnel(d)
    } finally {
      setLoadingFunnel(false)
    }
  }, [rangeParams])

  const loadBreakdown = useCallback(async () => {
    setLoadingBreakdown(true)
    try {
      const d = await http.get('/admin/analytics/breakdown', { params: { dim, ...rangeParams() } })
      setBreakdown(d)
    } finally {
      setLoadingBreakdown(false)
    }
  }, [dim, rangeParams])

  useEffect(() => { loadFunnel() }, [loadFunnel])
  useEffect(() => { loadBreakdown() }, [loadBreakdown])

  // 漏斗：按 FUNNEL 顺序对齐后端返回
  const steps = FUNNEL.map((f) => {
    const s = funnel?.steps?.find((x) => x.step === f.step)
    return { ...f, count: s?.count ?? 0, fromPrev: s?.fromPrev, fromTop: s?.fromTop }
  })
  const topCount = steps[0]?.count || 0

  // 维度下钻表格
  const dimTitle = dim === 'plan' ? '套餐' : dim === 'persona' ? '角色' : '场景'
  const dimColumns = [
    { title: dimTitle, dataIndex: 'value', width: 140, fixed: 'left' },
    ...FUNNEL.map((f) => ({
      title: f.label, width: 120, align: 'center',
      render: (_, row) => row.counts?.[f.step] ?? 0,
    })),
  ]
  const dimRows = (breakdown?.rows || []).map((r, i) => ({
    key: i, value: r.value, counts: r.counts,
  }))

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16, flexWrap: 'wrap' }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin')}>返回</Button>
        <Text strong style={{ fontSize: 18 }}>埋点漏斗</Text>
        <RangePicker value={range} onChange={setRange} allowClear={false} />
        <Button icon={<ReloadOutlined />} onClick={() => { loadFunnel(); loadBreakdown() }}>刷新</Button>
      </Space>

      <Card title="转化漏斗（注册 → 支付成功）" style={{ marginBottom: 16 }}>
        <Spin spinning={loadingFunnel}>
          {topCount === 0 && !loadingFunnel ? (
            <Empty description="所选时间范围内无漏斗事件" />
          ) : (
            steps.map((s, i) => (
              <div
                key={s.step}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: i < steps.length - 1 ? '1px solid #f0f0f0' : 'none' }}
              >
                <Tag color="blue" style={{ width: 28, textAlign: 'center' }}>{i + 1}</Tag>
                <div style={{ width: 140 }}>{s.label}</div>
                <div style={{ width: 70, fontWeight: 600 }}>{s.count}</div>
                <div style={{ width: 130 }}>
                  <Text type="secondary">较上步 {pct(s.fromPrev)}</Text>
                </div>
                <Progress
                  percent={topCount ? Math.round((s.count / topCount) * 100) : 0}
                  style={{ flex: 1, marginRight: 0 }}
                  strokeColor="#4f46e5"
                  size="small"
                />
                <div style={{ width: 70, textAlign: 'right' }}>
                  <Text type="secondary">{pct(s.fromTop)}</Text>
                </div>
              </div>
            ))
          )}
        </Spin>
      </Card>

      <Card title="维度下钻">
        <Space style={{ marginBottom: 16 }}>
          <Segmented options={DIM_OPTIONS} value={dim} onChange={setDim} />
        </Space>
        <Spin spinning={loadingBreakdown}>
          <Table
            columns={dimColumns}
            dataSource={dimRows}
            pagination={false}
            size="small"
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: <Empty description="无数据" /> }}
          />
        </Spin>
      </Card>
    </div>
  )
}
