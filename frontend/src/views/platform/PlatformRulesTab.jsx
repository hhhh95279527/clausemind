// frontend/src/views/platform/PlatformRulesTab.jsx
// 超管控制台 · 全局审查规则：review_rules 列表/新建/编辑/启停/删除 + 规则试运行（不落库）。
// 这些规则对所有租户的每次审查生效，接口走 /api/platform/*（PLATFORM_ADMIN 鉴权）。
import { useCallback, useEffect, useState } from 'react'
import {
  Button, Table, Tag, Switch, Space, Input, Select, Modal, Form, InputNumber,
  Drawer, Alert, Empty, Tooltip, Popconfirm, Typography, App as AntApp, Collapse,
} from 'antd'
import {
  PlusOutlined, ReloadOutlined, EditOutlined, DeleteOutlined,
  ExperimentOutlined, ThunderboltOutlined, LineChartOutlined,
} from '@ant-design/icons'
import platformApi, { platformErrMessage } from '@/utils/platformApi.js'
import styles from './PlatformRulesTab.module.css'

const { TextArea } = Input
const { Text } = Typography

const SEVERITY_META = {
  HIGH: { color: 'red', label: '高风险' },
  MED: { color: 'orange', label: '中风险' },
  LOW: { color: 'blue', label: '低风险' },
}

// 规则作用域（与后端 SCOPES 白名单对齐）：LABOR=劳动关系，INTERNSHIP=实习协议（互不重叠）
const SCOPE_OPTIONS = [
  { value: 'ALL', label: '全部合同' },
  { value: 'LABOR', label: '仅劳动用工合同' },
  { value: 'INTERNSHIP', label: '仅实习协议' },
]
const SCOPE_LABEL = { ALL: '全部合同', LABOR: '劳动用工', INTERNSHIP: '实习协议' }
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
  const { message } = AntApp.useApp()

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
      setResult(await platformApi.post('/rules/try', body))
    } catch (err) {
      message.error(platformErrMessage(err, '试跑失败'))
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
          message="试运行只是演练，不会保存规则，也不影响线上审查"
          description="用和真实审查完全一样的判定逻辑：优先按正则匹配；正则没配、写错或没匹配上时，改按「全部关键词都出现」来判定。"
        />
        <Space wrap>
          <span>条款来自哪种合同：</span>
          <Select
            value={domain}
            onChange={setDomain}
            style={{ width: 180 }}
            options={[
              { value: 'ALL', label: '通用合同条款' },
              { value: 'LABOR', label: '劳动/用工合同' },
              { value: 'INTERNSHIP', label: '实习协议' },
            ]}
          />
          {preset?.rule?.scope && preset.rule.scope !== 'ALL' && preset.rule.scope !== domain && (
            <Tag color={SCOPE_TAG_COLOR[preset.rule.scope] || 'default'}>
              本规则只用于{SCOPE_LABEL[preset.rule.scope]}，当前选的合同类型不会执行它
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
    return <Alert type="warning" showIcon message="规则被跳过" description="这条规则只用于劳动/用工合同（在上方切换合同类型再试）。" />
  }
  if (!result.hit) {
    return (
      <Alert
        type="success"
        showIcon
        message="未命中"
        description={result.regexError ? `正则表达式写错了（已自动改用关键词判定，仍未命中）：${result.regexError}` : '这段文本不会触发本规则。'}
      />
    )
  }
  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      <Alert
        type="error"
        showIcon
        message={`命中 ${result.matchCount} 处 · 判定方式：${result.mode === 'pattern' ? '正则匹配' : '关键词全部出现'}`}
        description={result.regexError ? `注意：正则写错了，这次是靠关键词兜底命中的。${result.regexError}` : null}
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

// ── 表单分组标题 ────────────────────────────────────────────────
function GroupTitle({ step, title, hint }) {
  return (
    <div className={styles.groupTitle}>
      <span className={styles.groupStep}>{step}</span>
      <div>
        <div className={styles.groupName}>{title}</div>
        {hint && <div className={styles.groupHint}>{hint}</div>}
      </div>
    </div>
  )
}

// ── 新建/编辑弹窗 ───────────────────────────────────────────────
function RuleFormModal({ open, rule, onClose, onSaved, onTry }) {
  const [form] = Form.useForm()
  const editing = !!rule?.id
  const [saving, setSaving] = useState(false)
  const { message } = AntApp.useApp()

  useEffect(() => {
    if (open) form.setFieldsValue(rule ? { ...EMPTY_RULE, ...rule, pattern: rule.pattern ?? '' } : EMPTY_RULE)
  }, [open, rule, form])

  const submit = async () => {
    const values = await form.validateFields()
    setSaving(true)
    try {
      if (editing) {
        await platformApi.put(`/rules/${rule.id}`, values)
      } else {
        await platformApi.post('/rules', values)
      }
      message.success(editing ? '规则已更新，全平台下次审查生效' : '规则已创建，全平台生效')
      onSaved()
      onClose()
    } catch (err) {
      message.error(platformErrMessage(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={editing ? `编辑规则：${rule.name || rule.code}` : '新建审查规则'}
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
          <Button onClick={() => onTry(form.getFieldsValue())} icon={<ExperimentOutlined />}>试运行（先验证再保存）</Button>
          <CancelBtn />
          <OkBtn />
        </Space>
      )}
    >
      <Form form={form} layout="vertical" initialValues={EMPTY_RULE}>
        {/* 第一组：这是什么风险 */}
        <GroupTitle step="1" title="这是什么风险" hint="给审查报告里的人看：这条规则抓的是什么问题、有多严重、用在哪些合同上" />
        <Form.Item name="name" label="规则名称" rules={[{ required: true, message: '请输入名称' }]}>
          <Input placeholder="如：试用期可能超过法定上限" maxLength={200} />
        </Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="category" label="风险分类" style={{ flex: 1 }} rules={[{ required: true, message: '请输入分类' }]}
            tooltip="审查报告里按这个分类归组，如：劳动用工 / 价款支付 / 保密与知识产权">
            <Input placeholder="劳动用工 / 商事合同 / 知识产权…" maxLength={50} />
          </Form.Item>
          <Form.Item name="severity" label="严重程度" style={{ width: 130 }} rules={[{ required: true }]}
            tooltip="高风险=可能违法或造成重大损失；中风险=明显不公平；低风险=建议完善">
            <Select options={[
              { value: 'HIGH', label: '高风险' },
              { value: 'MED', label: '中风险' },
              { value: 'LOW', label: '低风险' },
            ]} />
          </Form.Item>
          <Form.Item name="scope" label="用在哪些合同" style={{ width: 170 }}
            tooltip="实习协议不是劳动关系，选「劳动用工」的规则不会在实习协议上跑，避免误报">
            <Select options={SCOPE_OPTIONS} />
          </Form.Item>
        </Space>

        {/* 第二组：怎么算命中 */}
        <GroupTitle step="2" title="怎么算命中" hint="两种判定方式自动配合：正则优先；正则没配、写错或没匹配上时，改按「全部关键词都出现」判定。下面的「AI 审查要点」则会在 AI 深度审查时作为检查重点交给 AI" />
        <Form.Item name="keywords" label="关键词（全部出现才算命中）"
          tooltip="最简单的配法：如「试用期」「违约金」。推荐至少配 2~3 个，宁多勿漏">
          <Select mode="tags" placeholder="输入关键词后回车，可多个" tokenSeparators={[',', '，']} />
        </Form.Item>
        <Form.Item name="pattern" label={<span>正则表达式 <Tag style={{ marginLeft: 4 }}>高级，可留空</Tag></span>}
          tooltip="比关键词更精准的匹配方式（JS 语法）。写错了不会影响线上审查——会自动降级为关键词判定，但请用试运行验证"
          extra={<Text type="secondary">例：试用期[^。；\n]{'{0,40}'}(六|七|八|九|十|[7-9])\s*个?月 可匹配「试用期为八个月」</Text>}>
          <TextArea rows={2} className={styles.regexInput} placeholder="可留空。留空就只按关键词判定" />
        </Form.Item>
        <Form.Item
          name="prompt"
          label={<span>AI 审查要点 <Tag color="green" style={{ marginLeft: 4 }}>必填，给 AI 看</Tag></span>}
          rules={[{ required: true, message: 'AI 深度审查依赖这段描述' }]}
          tooltip="AI 审查合同时会把这段描述当作检查重点。请写清楚：什么情况算踩线、法定的边界在哪（如「试用期最长不得超过 6 个月」）"
          extra={<Text type="secondary">AI 会理解语义，所以这里写「判断标准」而不是关键词，越具体 AI 判得越准</Text>}
        >
          <TextArea rows={3} placeholder="如：约定试用期超过 6 个月（三年期以上合同最长 6 个月），或同一用人单位与同一劳动者约定超过一次试用期" />
        </Form.Item>

        {/* 第三组：命中后说什么 */}
        <GroupTitle step="3" title="命中后告诉用户什么" hint="这些内容会原样出现在审查报告里，是用户能直接拿去改合同的依据" />
        <Form.Item name="description" label="风险解释（为什么这是问题）">
          <TextArea rows={2} placeholder="如：试用期超过法定上限，超出部分无效，企业可能面临赔偿" />
        </Form.Item>
        <Space style={{ display: 'flex' }} align="start">
          <Form.Item name="suggestion" label="修改建议" style={{ flex: 1 }}>
            <TextArea rows={2} placeholder="如：将试用期改为 2 个月并同步调整工资结构" />
          </Form.Item>
          <Form.Item name="legalBasis" label="法律依据" style={{ flex: 1 }}>
            <TextArea rows={2} placeholder="如：《劳动合同法》第十九条" />
          </Form.Item>
        </Space>

        {/* 高级：默认收起 */}
        <Collapse ghost items={[{
          key: 'adv',
          label: '高级选项（编码 / 排序，一般不用动）',
          children: (
            <Space style={{ display: 'flex' }} align="start">
              <Form.Item name="code" label="规则编码" style={{ flex: 1 }}
                rules={[{ required: true, message: '请输入编码' }, { pattern: /^[A-Z][A-Z0-9_-]*$/, message: '大写字母开头，仅含 A-Z/0-9/-/_' }]}
                tooltip="系统内部的唯一编号。新建时建议带分类前缀（如 LABOR-XXX），保存后不可修改">
                <Input placeholder="LABOR-OVERTIME" disabled={editing} style={{ fontFamily: 'monospace' }} />
              </Form.Item>
              <Form.Item name="enabled" label="状态" valuePropName="checked">
                <Switch checkedChildren="启用" unCheckedChildren="停用" />
              </Form.Item>
              <Form.Item name="sortOrder" label="显示顺序" style={{ width: 110 }} tooltip="数字越小排越前，仅影响列表顺序">
                <InputNumber min={0} max={9999} style={{ width: '100%' }} />
              </Form.Item>
            </Space>
          ),
        }]} />
      </Form>
    </Modal>
  )
}

// ── Tab 主体 ─────────────────────────────────────────────────────
export default function PlatformRulesTab({ onGoEval }) {
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
      setData(await platformApi.get('/rules', { params }))
    } catch (err) {
      message.error(platformErrMessage(err, '规则列表加载失败'))
    } finally {
      setLoading(false)
    }
  }, [page, q, scope, enabled, message])

  useEffect(() => { load() }, [load])

  const toggleEnabled = async (rule, value) => {
    try {
      await platformApi.put(`/rules/${rule.id}`, { enabled: value })
      setChanged(true)
      message.success(`规则「${rule.name || rule.code}」已${value ? '启用' : '停用'}`)
      load()
    } catch (err) {
      message.error(platformErrMessage(err, '操作失败'))
    }
  }

  const removeRule = async (rule) => {
    try {
      await platformApi.delete(`/rules/${rule.id}`)
      setChanged(true)
      message.success('规则已删除')
      load()
    } catch (err) {
      message.error(platformErrMessage(err, '删除失败'))
    }
  }

  const columns = [
    {
      title: '规则', dataIndex: 'name', width: 300, fixed: 'left',
      render: (name, r) => (
        <div>
          <div className={styles.ruleName}>{name}</div>
          <Text type="secondary" code style={{ fontSize: 12 }}>{r.code}</Text>
        </div>
      ),
    },
    {
      title: '严重程度', dataIndex: 'severity', width: 92,
      render: (s) => <Tag color={SEVERITY_META[s].color}>{SEVERITY_META[s].label}</Tag>,
    },
    { title: '分类', dataIndex: 'category', width: 110, render: (c) => <Tag>{c}</Tag> },
    {
      title: '用在哪些合同', dataIndex: 'scope', width: 108,
      render: (s) => <Tag color={SCOPE_TAG_COLOR[s] || 'default'}>{SCOPE_LABEL[s] || s}</Tag>,
    },
    {
      title: '怎么判命中', key: 'detect', width: 190,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.pattern && (
            <Tooltip title={<span style={{ fontFamily: 'monospace' }}>{r.pattern}</span>}>
              <Tag color="geekblue">正则匹配</Tag>
            </Tooltip>
          )}
          {r.keywords?.length > 0 && (
            <Tooltip title={r.keywords.join('、')}>
              <Tag color="cyan">{r.keywords.length} 个关键词</Tag>
            </Tooltip>
          )}
          {!r.pattern && !r.keywords?.length && (
            <Tooltip title="没有配正则和关键词，规则轨不会命中，只有 AI 审查会参考它的「AI 审查要点」">
              <Tag>仅 AI 审查</Tag>
            </Tooltip>
          )}
          <Tooltip title={r.prompt} placement="topLeft">
            <Tag style={{ cursor: 'help' }}>AI 要点</Tag>
          </Tooltip>
        </Space>
      ),
    },
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
            title={`删除规则「${r.name || r.code}」？`}
            description="已经审完的报告不受影响，但之后的新审查不会再执行这条规则。"
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
        <h2 className={styles.title}>全局审查规则</h2>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, rule: null })}>新建规则</Button>
        </Space>
      </div>

      {/* 规则如何工作：可关闭说明卡 */}
      <Alert
        type="info"
        showIcon
        message="这些规则是整个产品的「法律底线检查清单」——所有企业的每次审查都会自动执行，改动立即全平台生效"
        description={(
          <div className={styles.guide}>
            <div className={styles.guideStep}><b>① 规则快检：</b>每次审查时，用关键词/正则逐条比对合同，毫秒级出结果、零 AI 成本，保证风险不漏检</div>
            <div className={styles.guideStep}><b>② AI 深查：</b>每条规则的「AI 审查要点」会作为检查重点交给 AI，让 AI 能抓到关键词抓不到的语义问题</div>
            <div className={styles.guideStep}><b>③ 报告呈现：</b>命中的规则按「风险解释 + 修改建议 + 法律依据」生成风险项，进入人工终审</div>
            <div className={styles.guideNote}>与企业「审查规则（Playbook）」的区别：这里是平台内置的法定规则（全租户共享）；Playbook 是每家企业自建的公司红线和偏好口径，只约束它自己。</div>
          </div>
        )}
        closable
      />

      {changed && (
        <Alert
          type="warning"
          showIcon
          message="规则已变更，将影响下一次合同审查"
          description="建议到离线评测页跑一次回归评测，确认新规则没有带来误报或漏报。"
          action={onGoEval ? <Button size="small" icon={<LineChartOutlined />} onClick={onGoEval}>前往离线评测</Button> : null}
        />
      )}

      <Space className={styles.filters} wrap>
        <Input.Search
          placeholder="搜索名称 / 编码 / 分类"
          allowClear
          style={{ width: 260 }}
          onSearch={(v) => { setPage(1); setQ(v) }}
        />
        <Select
          placeholder="用在哪些合同"
          allowClear
          style={{ width: 160 }}
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
        scroll={{ x: 1100 }}
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
