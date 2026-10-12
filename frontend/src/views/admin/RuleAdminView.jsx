// frontend/src/views/admin/RuleAdminView.jsx
// 审查规则管理后台：review_rules 列表/新建/编辑/启停/删除 + 规则试运行（不落库，展示命中+quote）。
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Table, Tag, Switch, Space, Input, Select, Modal, Form, InputNumber,
  Drawer, Alert, Empty, Tooltip, Popconfirm, Typography, App as AntApp,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
  ExperimentOutlined, ArrowLeftOutlined, ThunderboltOutlined,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import styles from './RuleAdminView.module.css'

const { TextArea } = Input
const { Text } = Typography

const SEVERITY_META = {
  HIGH: { color: 'red', label: '高' },
  MED: { color: 'orange', label: '中' },
  LOW: { color: 'blue', label: '低' },
}

// 规则作用域（与后端 SCOPES 白名单对齐）：LABOR=劳动关系，INTERNSHIP=实习协议（互不重叠）
const SCOPE_OPTIONS = [
  { value: 'ALL', label: 'ALL 所有合同' },
  { value: 'LABOR', label: 'LABOR 劳动用工' },
  { value: 'INTERNSHIP', label: 'INTERNSHIP 实习协议' },
]
const SCOPE_TAG_COLOR = { LABOR: 'purple', INTERNSHIP: 'cyan' }

const SAMPLE_CLAUSE = '第三条 试用期：乙方试用期为八个月，试用期内工资按转正工资的70%发放；若乙方提前离职，应向甲方支付违约金5000元。'

const EMPTY_RULE = {
  code: '',
  name: '',
  severity: 'MED',
  category: '',
  scope: 'ALL',
  pattern: '',
  keywords: [],
  prompt: '',
  description: '',
  suggestion: '',
  legalBasis: '',
  enabled: true,
  sortOrder: 100,
}

// ── 试运行抽屉：已存规则传 id，编辑中的规则传 rule 字段 ──────────────
function TryDrawer({ open, preset, onClose }) {
  // 试运行的合同域：ALL=通用条款 / LABOR=劳动关系 / INTERNSHIP=实习协议
  const [domain, setDomain] = useState('ALL')
  const [text, setText] = useState(SAMPLE_CLAUSE)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    if (open) {
      setResult(null)
      const scope = preset?.rule?.scope
      setDomain(scope === 'LABOR' || scope === 'INTERNSHIP' ? scope : 'ALL')
    }
  }, [open, preset])

  const run = async () => {
    setLoading(true)
    try {
      const body = { text, labor: domain === 'LABOR', internship: domain === 'INTERNSHIP' }
      if (preset?.id) body.id = preset.id
      if (preset?.rule) body.rule = preset.rule
      setResult(await http.post('/admin/rules/try', body))
    } catch {
      // 全局拦截器已 toast
    } finally {
      setLoading(false)
    }
  }

  return (
    <Drawer
      title={<Space><ExperimentOutlined /> 规则试运行<span className={styles.tryCode}>{preset?.rule?.code || preset?.id || '未保存规则'}</span></Space>}
      width={560}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={<Button type="primary" icon={<ThunderboltOutlined />} loading={loading} onClick={run}>开始检测</Button>}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="试运行不会保存规则，也不影响线上审查"
          description="使用与线上规则引擎完全一致的命中逻辑：正则优先，正则非法或未命中时降级为关键词全部包含。"
        />
        <Space wrap>
          <span>合同类型：</span>
          <Select
            value={domain}
            onChange={setDomain}
            style={{ width: 180 }}
            options={[
              { value: 'ALL', label: '通用合同' },
              { value: 'LABOR', label: '劳动/用工合同' },
              { value: 'INTERNSHIP', label: '实习协议' },
            ]}
          />
          {preset?.rule?.scope && preset.rule.scope !== 'ALL' && preset.rule.scope !== domain && (
            <Tag color={SCOPE_TAG_COLOR[preset.rule.scope] || 'default'}>
              该规则 scope={preset.rule.scope}，当前合同域不会执行
            </Tag>
          )}
        </Space>
        <TextArea
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="粘贴一段条款原文…"
          className={styles.clauseInput}
        />
        {result && <TryResult result={result} />}
      </Space>
    </Drawer>
  )
}

function TryResult({ result }) {
  if (result.skipped) {
    return <Alert type="warning" showIcon message="规则被跳过" description="scope=LABOR 的规则仅在劳动/用工类合同上运行（打开上方开关再试）。" />
  }
  if (!result.hit) {
    return (
      <Alert
        type="success"
        showIcon
        message="未命中"
        description={result.regexError ? `正则非法（已降级关键词判定仍未命中）：${result.regexError}` : '该段文本不会触发本规则。'}
      />
    )
  }
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Alert
        type="error"
        showIcon
        message={`命中 ${result.matchCount} 处 · 命中方式：${result.mode === 'pattern' ? '正则匹配' : '关键词全包含'}`}
        description={result.regexError ? `注意：正则非法，实际靠关键词兜底命中。${result.regexError}` : null}
      />
      {result.matches.map((m, i) => (
        <div key={i} className={styles.quoteCard}>
          <div className={styles.quoteHead}>命中位置 {i + 1}（字符偏移 {m.index}）</div>
          <div className={styles.quoteText}>{m.quote}</div>
        </div>
      ))}
    </Space>
  )
}

// ── 新建/编辑弹窗 ───────────────────────────────────────────────
function RuleFormModal({ open, rule, onClose, onSaved, onTry }) {
  const [form] = Form.useForm()
  const editing = !!rule?.id
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) form.setFieldsValue(rule ? { ...EMPTY_RULE, ...rule, pattern: rule.pattern ?? '' } : EMPTY_RULE)
  }, [open, rule, form])

  const submit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await http.put(`/admin/rules/${rule.id}`, values)
      } else {
        await http.post('/admin/rules', values)
      }
      onSaved()
      onClose()
    } catch {
      // 校验失败或接口报错：拦截器已提示
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `编辑规则 ${rule.code}` : '新建审查规则'}
      open={open}
      onCancel={onClose}
      width={760}
      destroyOnClose
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={submit}
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          <Button onClick={() => onTry(form.getFieldsValue())} icon={<ExperimentOutlined />}>试运行</Button>
          <CancelBtn />
          <OkBtn />
        </Space>
      )}
    >
      <Form form={form} layout="vertical" initialValues={EMPTY_RULE}>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="code" label="规则编码" style={{ flex: 1 }}
            rules={[{ required: true, message: '请输入编码' }, { pattern: /^[A-Z][A-Z0-9_-]*$/, message: '大写字母开头，仅含 A-Z/0-9/-/_' }]}
            tooltip="唯一编码，建议带分类前缀，如 LABOR-XXX。保存后不可修改（评测/反馈数据以编码关联）。">
            <Input placeholder="LABOR-OVERTIME" disabled={editing} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Form.Item name="severity" label="严重度" style={{ width: 110 }} rules={[{ required: true }]}>
            <Select options={[
              { value: 'HIGH', label: '高 HIGH' },
              { value: 'MED', label: '中 MED' },
              { value: 'LOW', label: '低 LOW' },
            ]} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" style={{ width: 96 }}>
            <InputNumber min={0} max={9999} style={{ width: '100%' }} />
          </Form.Item>
        </Space>
        <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="如：试用期可能超过法定上限" maxLength={200} />
        </Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="category" label="风险分类" style={{ flex: 1 }} rules={[{ required: true, message: '请输入分类' }]}>
            <Input placeholder="劳动用工 / 商事合同 / 知识产权…" maxLength={50} />
          </Form.Item>
          <Form.Item name="scope" label="适用范围" style={{ width: 190 }} tooltip="LABOR=劳动用工合同；INTERNSHIP=实习协议（不构成劳动关系）；其余合同只跑 ALL">
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch checkedChildren="启用" unCheckedChildren="停用" />
          </Form.Item>
        </Space>
        <Form.Item name="pattern" label="命中正则（JS 语法，不含 / 定界符）"
          tooltip="留空则仅按关键词判定；非法正则不会拖垮审查，但会静默降级——请用试运行验证。"
          extra={<Text type="secondary">例：试用期[^。；\n]{'{0,40}'}(六|七|八|九|十|[7-9])\s*个?月</Text>}>
          <TextArea rows={2} className={styles.regexInput} placeholder="可空。与线上引擎一致使用 m 标志（试运行额外按全局列出全部命中）" />
        </Form.Item>
        <Form.Item name="keywords" label="兜底关键词（全部出现才命中）" tooltip="正则缺失/非法/未命中时生效，宁多勿漏">
          <Select mode="tags" placeholder="输入关键词后回车，可多个" tokenSeparators={[',', '，']} />
        </Form.Item>
        <Form.Item name="prompt" label="语义判定描述（AI 轨 prompt）" rules={[{ required: true, message: 'AI 轨依赖该描述' }]}>
          <TextArea rows={3} placeholder="描述该风险的判定标准与法定边界，供 Agent 轨做语义判断" />
        </Form.Item>
        <Form.Item name="description" label="风险解释（命中后写入审查意见 analysis）">
          <TextArea rows={2} placeholder="命中后展示给用户的风险分析" />
        </Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="suggestion" label="修改建议" style={{ flex: 1 }}>
            <TextArea rows={2} />
          </Form.Item>
          <Form.Item name="legalBasis" label="法律依据" style={{ flex: 1 }}>
            <TextArea rows={2} />
          </Form.Item>
        </Space>
      </Form>
    </Modal>
  )
}

// ── 主页面 ─────────────────────────────────────────────────────
export default function RuleAdminView() {
  const navigate = useNavigate()
  const { message } = AntApp.useApp()
  const [data, setData] = useState({ rules: [], total: 0 })
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState('')
  const [scope, setScope] = useState()
  const [enabled, setEnabled] = useState()
  const [page, setPage] = useState(1)
  const [modal, setModal] = useState({ open: false, rule: null })
  const [tryPreset, setTryPreset] = useState(null)
  const [changed, setChanged] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = { page, pageSize: 20 }
      if (q) params.q = q
      if (scope) params.scope = scope
      if (enabled) params.enabled = enabled
      setData(await http.get('/admin/rules', { params }))
    } finally {
      setLoading(false)
    }
  }, [page, q, scope, enabled])

  useEffect(() => { load() }, [load])

  const toggleEnabled = async (rule, value) => {
    await http.put(`/admin/rules/${rule.id}`, { enabled: value })
    setChanged(true)
    message.success(`规则 ${rule.code} 已${value ? '启用' : '停用'}`)
    load()
  }

  const removeRule = async (rule) => {
    await http.delete(`/admin/rules/${rule.id}`)
    message.success(`规则 ${rule.code} 已删除`)
    load()
  }

  const columns = [
    {
      title: '编码', dataIndex: 'code', width: 220, fixed: 'left',
      render: (code) => <Text code copyable>{code}</Text>,
    },
    { title: '规则名称', dataIndex: 'name', width: 220 },
    {
      title: '严重度', dataIndex: 'severity', width: 80,
      render: (s) => <Tag color={SEVERITY_META[s].color}>{SEVERITY_META[s].label}</Tag>,
    },
    { title: '分类', dataIndex: 'category', width: 110, render: (c) => <Tag>{c}</Tag> },
    {
      title: '范围', dataIndex: 'scope', width: 78,
      render: (s) => <Tag color={SCOPE_TAG_COLOR[s] || 'default'}>{s}</Tag>,
    },
    {
      title: '命中方式', width: 150,
      render: (_, r) => (
        <Space size={4} wrap>
          <Tooltip title={r.pattern || '未配置正则'}>
            <Tag color={r.pattern ? 'geekblue' : 'default'}>{r.pattern ? '正则' : '无正则'}</Tag>
          </Tooltip>
          <span className={styles.kwCount}>{r.keywords?.length ? `${r.keywords.length} 关键词` : ''}</span>
        </Space>
      ),
    },
    { title: '排序', dataIndex: 'sortOrder', width: 64 },
    {
      title: '启用', dataIndex: 'enabled', width: 70,
      render: (v, r) => <Switch size="small" checked={v} onChange={(val) => toggleEnabled(r, val)} />,
    },
    {
      title: '操作', width: 210, fixed: 'right',
      render: (_, r) => (
        <Space size={4}>
          <Button size="small" icon={<ExperimentOutlined />} onClick={() => setTryPreset({ id: r.id, rule: { code: r.code, scope: r.scope } })}>试运行</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => setModal({ open: true, rule: r })}>编辑</Button>
          <Popconfirm
            title={`删除规则 ${r.code}？`}
            description="历史报告不受影响，但之后的新审查不再执行该规则。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => removeRule(r)}
          >
            <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.headRow}>
        <Space>
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin')}>返回管理后台</Button>
          <h2 className={styles.title}>审查规则管理</h2>
        </Space>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, rule: null })}>新建规则</Button>
        </Space>
      </div>

      {changed && (
        <Alert
          type="warning"
          showIcon
          message="规则变更将影响下次合同审查"
          description="建议跑一次离线评测，确认 precision/recall 没有回退。"
          action={<Button size="small" onClick={() => navigate('/admin/eval')}>前往评测报告</Button>}
        />
      )}

      <Space className={styles.filters} wrap>
        <Input.Search
          placeholder="搜索编码 / 名称 / 分类"
          allowClear
          style={{ width: 260 }}
          onSearch={(v) => { setPage(1); setQ(v) }}
        />
        <Select
          placeholder="适用范围"
          allowClear
          style={{ width: 150 }}
          value={scope}
          onChange={(v) => { setPage(1); setScope(v) }}
          options={SCOPE_OPTIONS}
        />
        <Select
          placeholder="启用状态"
          allowClear
          style={{ width: 120 }}
          value={enabled}
          onChange={(v) => { setPage(1); setEnabled(v) }}
          options={[{ value: 'true', label: '已启用' }, { value: 'false', label: '已停用' }]}
        />
        <Text type="secondary">共 {data.total} 条规则</Text>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={data.rules}
        size="small"
        scroll={{ x: 1250 }}
        locale={{ emptyText: <Empty description="没有符合条件的规则" /> }}
        pagination={{
          current: page,
          pageSize: 20,
          total: data.total,
          showSizeChanger: false,
          onChange: setPage,
        }}
      />

      <RuleFormModal
        open={modal.open}
        rule={modal.rule}
        onClose={() => setModal({ open: false, rule: null })}
        onSaved={() => { setChanged(true); setPage(1); load() }}
        onTry={(values) => setTryPreset({ rule: values })}
      />
      <TryDrawer open={!!tryPreset} preset={tryPreset} onClose={() => setTryPreset(null)} />
    </div>
  )
}
