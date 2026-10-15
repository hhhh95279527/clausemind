// frontend/src/views/platform/PlatformBillingTab.jsx
// 超管控制台 · 租户账单：全租户当前账期汇总 → 点击行查看该租户完整账单
// （本月配额进度、按天峰/谷费用折线、功能费用占比、超额账期、历史账期）。
// 图表全部用轻量 SVG 自绘，不引入 echarts 重依赖。接口走 /api/platform/billing/*。
import { useCallback, useEffect, useState } from 'react'
import {
  Alert, Button, Card, Col, Empty, Progress, Row, Space, Spin, Statistic, Table, Tag, Tooltip, Typography,
  App as AntApp,
} from 'antd'
import {
  ArrowLeftOutlined, CrownFilled, ExclamationCircleFilled, ReloadOutlined, ThunderboltFilled, WalletFilled,
} from '@ant-design/icons'
import platformApi, { platformErrMessage } from '@/utils/platformApi.js'
import styles from './PlatformBillingTab.module.css'

const { Text } = Typography

const FEATURE_COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#9ca3af']
const PEAK_COLOR = '#f59e0b'
const OFF_COLOR = '#10b981'

function fmtInt(n) {
  return Number(n || 0).toLocaleString('zh-CN')
}

// ── 峰谷费用折线（纯 SVG）────────────────────────────────────────
function PeakLineChart({ daily }) {
  const W = 760
  const H = 240
  const PAD = { top: 16, right: 16, bottom: 28, left: 56 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const n = daily.length
  const maxCost = Math.max(...daily.map((d) => d.costCny), 0.0001)
  const yMax = maxCost * 1.15

  const x = (i) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const y = (v) => PAD.top + innerH - (v / yMax) * innerH

  const linePath = (key) =>
    daily.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(' ')

  const areaPath = (key) =>
    `${linePath(key)} L${x(n - 1).toFixed(1)},${(PAD.top + innerH).toFixed(1)} L${x(0).toFixed(1)},${(
      PAD.top + innerH
    ).toFixed(1)} Z`

  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((r) => r * yMax)
  const labelStep = Math.max(1, Math.ceil(n / 10))

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${W} ${H}`} className={styles.svgChart} role="img" aria-label="按天峰谷费用折线">
        {gridVals.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={styles.gridLine} />
            <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className={styles.axisText}>
              ¥{v >= 0.1 ? v.toFixed(2) : v.toFixed(3)}
            </text>
          </g>
        ))}
        <path d={areaPath('peakCost')} fill={PEAK_COLOR} opacity={0.08} />
        <path d={areaPath('offPeakCost')} fill={OFF_COLOR} opacity={0.08} />
        <path d={linePath('peakCost')} fill="none" stroke={PEAK_COLOR} strokeWidth={2} />
        <path d={linePath('offPeakCost')} fill="none" stroke={OFF_COLOR} strokeWidth={2} />
        {daily.map((d, i) => (
          <g key={d.date}>
            {d.peakCost > 0 && (
              <circle cx={x(i)} cy={y(d.peakCost)} r={3} fill={PEAK_COLOR}>
                <title>{`${d.date} 高峰 ¥${d.peakCost.toFixed(4)}（${d.calls} 次调用）`}</title>
              </circle>
            )}
            {d.offPeakCost > 0 && (
              <circle cx={x(i)} cy={y(d.offPeakCost)} r={3} fill={OFF_COLOR}>
                <title>{`${d.date} 空闲 ¥${d.offPeakCost.toFixed(4)}（${d.calls} 次调用）`}</title>
              </circle>
            )}
            {i % labelStep === 0 && (
              <text x={x(i)} y={H - 8} textAnchor="middle" className={styles.axisText}>{d.label}</text>
            )}
          </g>
        ))}
      </svg>
      <div className={styles.legend}>
        <span className={styles.legendItem}><i style={{ background: PEAK_COLOR }} />高峰费用（工作日 9-12/14-18）</span>
        <span className={styles.legendItem}><i style={{ background: OFF_COLOR }} />空闲费用（夜间/周末半价）</span>
      </div>
    </div>
  )
}

// ── 功能费用占比环图（stroke-dasharray 拼段）──────────────────────
function FeatureDonut({ items }) {
  const size = 180
  const r = 64
  const c = 2 * Math.PI * r
  const total = items.reduce((s, i) => s + i.costCny, 0)
  let acc = 0

  return (
    <div className={styles.donutWrap}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="功能费用占比">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={18} />
        {total > 0 &&
          items.filter((i) => i.costCny > 0).map((i, idx) => {
            const frac = i.costCny / total
            const seg = (
              <circle
                key={i.feature}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={FEATURE_COLORS[idx % FEATURE_COLORS.length]}
                strokeWidth={18}
                strokeDasharray={`${(frac * c).toFixed(2)} ${(c - frac * c).toFixed(2)}`}
                strokeDashoffset={(-acc * c).toFixed(2)}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
              >
                <title>{`${i.label} ¥${i.costCny.toFixed(4)}（${i.costPct}%）`}</title>
              </circle>
            )
            acc += frac
            return seg
          })}
        <text x="50%" y="46%" textAnchor="middle" className={styles.donutTotal}>¥{total.toFixed(2)}</text>
        <text x="50%" y="62%" textAnchor="middle" className={styles.donutHint}>本月费用</text>
      </svg>
      <div className={styles.donutLegend}>
        {items.length === 0 && <Text type="secondary">本月暂无功能调用</Text>}
        {items.map((i, idx) => (
          <div key={i.feature} className={styles.donutRow}>
            <i style={{ background: FEATURE_COLORS[idx % FEATURE_COLORS.length] }} />
            <span className={styles.donutLabel}>{i.label}</span>
            <span className={styles.donutPct}>{i.costPct}%</span>
            <span className={styles.donutCost}>¥{i.costCny.toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 指定租户完整账单 ────────────────────────────────────────────────
function TenantBillingDetail({ tenantId, onBack }) {
  const { message } = AntApp.useApp()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await platformApi.get(`/billing/tenants/${tenantId}`))
    } catch (err) {
      message.error(platformErrMessage(err, '账单加载失败'))
    } finally {
      setLoading(false)
    }
  }, [tenantId, message])

  useEffect(() => { load() }, [load])

  if (loading) return <Spin style={{ display: 'block', marginTop: 120 }} />
  if (!data) return <Empty description="账单数据不可用" style={{ marginTop: 120 }} />

  const { tenant, period, usage, monthTotals, daily, byFeature, monthly, overLimitMonths } = data
  const progressStatus = usage.usedPct >= 100 ? 'exception' : usage.usedPct >= 80 ? 'normal' : 'success'

  return (
    <div className={styles.dashboard}>
      <div className={styles.backBar}>
        <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>返回租户列表</Button>
        <Button size="small" icon={<ReloadOutlined />} onClick={load} style={{ marginLeft: 8 }}>刷新</Button>
      </div>

      <div className={styles.headRow}>
        <Space>
          <span className={styles.tenantName}>{tenant.name}</span>
          <Tag>{tenant.plan}</Tag>
          {tenant.status === 'DISABLED' && <Tag color="red">已停用</Tag>}
          <Text type="secondary">账期 {period}（北京时间）</Text>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="本月费用" value={usage.costCny.toFixed(4)} prefix="¥" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              <WalletFilled /> 累计 {fmtInt(monthTotals.calls)} 次调用
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="Token 用量" value={fmtInt(usage.usedTokens)} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              入 {fmtInt(usage.inputTokens)} / 出 {fmtInt(usage.outputTokens)}
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic title="月度配额" value={fmtInt(tenant.quota)} suffix="tok" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              <CrownFilled /> {tenant.plan} 套餐
            </Text>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card size="small">
            <Statistic
              title="配额状态"
              value={usage.overLimit ? '已超额' : usage.usedPct >= 80 ? '接近上限' : '正常'}
              valueStyle={{ color: usage.overLimit ? '#dc2626' : usage.usedPct >= 80 ? '#d97706' : '#16a34a', fontSize: 20 }}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>
              <ThunderboltFilled /> 次月 1 日重置
            </Text>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="本月配额使用进度">
        <Progress
          percent={Math.min(usage.usedPct, 100)}
          status={progressStatus}
          strokeColor={usage.usedPct >= 100 ? { from: '#ef4444', to: '#f59e0b' } : undefined}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {fmtInt(usage.usedTokens)} / {fmtInt(tenant.quota)} tokens（{usage.usedPct}%）
          {usage.usedPct >= 100 && ' · 新调用将被 429 拦截，请升级套餐'}
          {usage.usedPct < 100 && usage.usedPct >= 80 && ' · 用量已超过 80%，请注意控制'}
        </Text>
      </Card>

      {overLimitMonths.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleFilled />}
          message={`检测到 ${overLimitMonths.length} 个超额账期`}
          description={
            <Space wrap>
              {overLimitMonths.map((m) => (
                <Tag key={m.period} color="orange">
                  {m.period}：{fmtInt(m.usedTokens)} tok（{m.usedPct}%）· ¥{m.costCny.toFixed(4)}
                </Tag>
              ))}
            </Space>
          }
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card size="small" title="按天峰谷费用（元）">
            {daily.some((d) => d.costCny > 0)
              ? <PeakLineChart daily={daily} />
              : <Empty description="本月暂无计费调用（规则轨/缓存命中不产生费用）" />}
          </Card>
        </Col>
        <Col xs={24} lg={9}>
          <Card size="small" title="功能费用占比">
            {byFeature.some((f) => f.costCny > 0)
              ? <FeatureDonut items={byFeature} />
              : <Empty description="本月暂无费用数据" />}
          </Card>
        </Col>
      </Row>

      <Card size="small" title="历史账期">
        <Table
          size="small"
          rowKey="period"
          pagination={false}
          dataSource={monthly}
          locale={{ emptyText: '暂无历史账期（本月为首个计费周期）' }}
          columns={[
            { title: '账期', dataIndex: 'period', width: 110 },
            {
              title: 'Token 用量', dataIndex: 'usedTokens', align: 'right',
              sorter: (a, b) => a.usedTokens - b.usedTokens,
              render: (v) => fmtInt(v),
            },
            { title: '输入', dataIndex: 'inputTokens', align: 'right', render: fmtInt },
            { title: '输出', dataIndex: 'outputTokens', align: 'right', render: fmtInt },
            {
              title: '配额使用率', dataIndex: 'usedPct', align: 'right', width: 170,
              render: (v, row) => (
                <Progress
                  percent={Math.min(v, 100)}
                  size="small"
                  status={row.overLimit ? 'exception' : v >= 80 ? 'normal' : 'success'}
                />
              ),
            },
            {
              title: '费用', dataIndex: 'costCny', align: 'right',
              render: (v) => `¥${Number(v).toFixed(4)}`,
              sorter: (a, b) => a.costCny - b.costCny,
            },
            {
              title: '状态', dataIndex: 'overLimit', width: 90,
              render: (over) => (over ? <Tag color="red">超额</Tag> : <Tag color="green">正常</Tag>),
            },
          ]}
        />
      </Card>
    </div>
  )
}

// ── Tab 主体：全租户账单列表 ────────────────────────────────────────
export default function PlatformBillingTab() {
  const { message } = AntApp.useApp()
  const [list, setList] = useState(null)
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setList(await platformApi.get('/billing/tenants'))
    } catch (err) {
      message.error(platformErrMessage(err, '租户账单加载失败'))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => { load() }, [load])

  if (selected) {
    return <TenantBillingDetail tenantId={selected.tenantId} onBack={() => setSelected(null)} />
  }

  return (
    <div>
      <div className={styles.headRow} style={{ marginBottom: 12 }}>
        <h2 className={styles.title}>租户配额账单（平台视角）</h2>
        <Tooltip title="刷新">
          <Button size="small" icon={<ReloadOutlined />} onClick={load} />
        </Tooltip>
      </div>
      <Spin spinning={loading}>
        <Table
          size="small"
          rowKey="tenantId"
          pagination={false}
          dataSource={list?.items || []}
          onRow={(row) => ({ onClick: () => setSelected(row), className: styles.clickableRow })}
          columns={[
            { title: '租户', dataIndex: 'name' },
            { title: '套餐', dataIndex: 'plan', width: 120, render: (p) => <Tag>{p}</Tag> },
            {
              title: '状态', dataIndex: 'status', width: 90,
              render: (s) => (s === 'ACTIVE' ? <Tag color="green">正常</Tag> : <Tag color="red">停用</Tag>),
            },
            {
              title: '本月 Token', dataIndex: 'usedTokens', align: 'right',
              render: (v) => fmtInt(v),
              sorter: (a, b) => a.usedTokens - b.usedTokens,
            },
            { title: '配额', dataIndex: 'quota', align: 'right', render: fmtInt },
            {
              title: '使用率', dataIndex: 'usedPct', width: 190,
              render: (v, row) => (
                <Progress
                  percent={Math.min(v, 100)}
                  size="small"
                  status={row.overLimit ? 'exception' : v >= 80 ? 'normal' : 'success'}
                />
              ),
            },
            {
              title: '本月费用', dataIndex: 'costCny', align: 'right', defaultSortOrder: 'descend',
              render: (v) => `¥${Number(v).toFixed(4)}`,
              sorter: (a, b) => a.costCny - b.costCny,
            },
            {
              title: '', width: 100,
              render: () => <Button type="link" size="small">账单明细 →</Button>,
            },
          ]}
        />
      </Spin>
    </div>
  )
}
