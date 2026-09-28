// frontend/src/views/team/PlaybookView.jsx
// 企业 Playbook 审查规则（FR-17，文案对齐 docs/prototype/playbook.html）：
// 红线规则 / 偏好口径 / 标准合同库（P1 占位）/ 行业专项包。
// 自然语言 → AI 结构化草稿（无 Key 可手写）；样例条款本地试命中不耗模型。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Checkbox, Drawer, Empty, Form, Input, Popconfirm, Select, Spin, Switch, Tooltip,
} from 'antd'
import {
  SafetyCertificateFilled, PlusOutlined, UploadOutlined, ApiOutlined,
} from '@ant-design/icons'
import { useMeStore } from '@/stores/me.js'
import { usePlaybookStore } from '@/stores/playbook.js'
import shared from '../personal/personal.module.css'
import css from './playbook.module.css'

const { TextArea } = Input

const TYPE_OPTIONS = [
  { label: '商务', value: 'SERVICE' },
  { label: '租赁', value: 'LEASE' },
  { label: '劳动', value: 'LABOR' },
  { label: '通用', value: 'ALL' },
]
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))
const TYPE_TAG_CLASS = { SERVICE: shared.tagOrange, LEASE: shared.tagOrange, LABOR: shared.tagBlue, ALL: shared.tagPurple }

const TABS = [
  { key: 'FORBIDDEN', label: '红线规则' },
  { key: 'PREFERENCE', label: '偏好口径' },
  { key: 'STANDARD', label: '标准合同库' },
  { key: 'PACK', label: '行业专项包' },
]

const KIND_META = {
  FORBIDDEN: { drawer: '红线规则 · 保存后立即对新发起的审查生效', defaultSeverity: 'HIGH' },
  PREFERENCE: { drawer: '偏好口径 · 命中后给出统一谈判建议，不判违规', defaultSeverity: 'LOW' },
}

function typeTags(types) {
  if (!types?.length) return <span className={`${shared.tag} ${shared.tagGray}`}>通用</span>
  return types.map((t) => (
    <span key={t} className={`${shared.tag} ${TYPE_TAG_CLASS[t] || shared.tagGray}`} style={{ marginRight: 4 }}>
      {TYPE_LABEL[t] || t}
    </span>
  ))
}

export default function PlaybookView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const {
    rules, packs, loading, loadAll, createRule, updateRule, toggleRule, deleteRule,
    parseRule, testRule, enablePack,
  } = usePlaybookStore()

  const [tab, setTab] = useState('FORBIDDEN')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新建；rule 对象=编辑
  const [drawerKind, setDrawerKind] = useState('FORBIDDEN')
  const [form] = Form.useForm()
  const suggestionRef = useRef('')
  const [parsing, setParsing] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResults, setTestResults] = useState(null)
  const [saving, setSaving] = useState(false)
  const [enabling, setEnabling] = useState(false)

  const isTeamSpace = entitlement?.workspaceType === 'TEAM'

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => {
    if (isTeamSpace) loadAll()
  }, [isTeamSpace, loadAll])

  const redlineRules = useMemo(() => rules.filter((r) => r.kind === 'FORBIDDEN'), [rules])
  const prefRules = useMemo(() => rules.filter((r) => r.kind === 'PREFERENCE'), [rules])

  // ── 个人空间：加锁付费墙（原型 #locked 文案）──
  if (entitlement && !isTeamSpace) {
    return (
      <div className={css.lockWrap}>
        <div className={css.lockCard}>
          <div className={css.lockIcon}><SafetyCertificateFilled /></div>
          <h3>Playbook 为团队版 / 企业版权益</h3>
          <p className={shared.muted}>个人版（PERSONAL）不支持公司级审查规则配置</p>
          <ul className={css.lockFeats}>
            <li><span className={shared.tick}>✓</span>红线规则 / 偏好口径 / 标准合同库 / 行业专项包</li>
            <li><span className={shared.tick}>✓</span>负责人 · 法务 · 成员三角色协作审批</li>
            <li><span className={shared.tick}>✓</span>规则命中统计与团队统一审查口径</li>
          </ul>
          <Button type="primary" size="large" block onClick={() => navigate('/pricing')}>了解团队版 TEAM</Button>
        </div>
      </div>
    )
  }

  const openCreate = (kind) => {
    setEditing(null)
    setDrawerKind(kind)
    suggestionRef.current = ''
    setTestResults(null)
    form.resetFields()
    form.setFieldsValue({
      kind,
      contractTypes: kind === 'FORBIDDEN' ? ['SERVICE', 'LEASE'] : ['SERVICE'],
      severity: KIND_META[kind].defaultSeverity,
    })
    setDrawerOpen(true)
  }

  const openEdit = (rule) => {
    setEditing(rule)
    setDrawerKind(rule.kind)
    suggestionRef.current = rule.pattern?.suggestion || ''
    setTestResults(null)
    form.setFieldsValue({
      title: rule.title,
      description: rule.description || '',
      naturalPrompt: rule.naturalPrompt || '',
      contractTypes: rule.contractTypes?.length ? rule.contractTypes : ['ALL'],
      keywords: (rule.pattern?.keywords || []).join('，'),
      regex: rule.pattern?.regex || '',
      severity: rule.pattern?.severity || (rule.kind === 'FORBIDDEN' ? 'HIGH' : 'LOW'),
    })
    setDrawerOpen(true)
  }

  const doParse = async () => {
    const prompt = (form.getFieldValue('naturalPrompt') || '').trim()
    if (prompt.length < 4) { form.setFields([{ name: 'naturalPrompt', errors: ['请用一句话描述规则（至少 4 个字）'] }]); return }
    setParsing(true)
    try {
      const res = await parseRule(prompt, form.getFieldValue('contractTypes') || [])
      form.setFieldsValue({
        keywords: (res.pattern.keywords || []).join('，'),
        regex: res.pattern.regex || '',
        severity: res.pattern.severity || 'MED',
      })
      suggestionRef.current = res.pattern.suggestion || ''
    } catch {
      // 拦截器已 toast（409：未配置 Key，手写区始终可用）
    } finally {
      setParsing(false)
    }
  }

  const buildPattern = () => {
    const kw = (form.getFieldValue('keywords') || '')
      .split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
    const regex = (form.getFieldValue('regex') || '').trim()
    if (!kw.length && !regex) {
      form.setFields([{ name: 'keywords', errors: ['关键词与正则至少填写一项，否则规则无法命中'] }])
      return null
    }
    return { keywords: kw, regex: regex || null, severity: form.getFieldValue('severity') || 'MED', suggestion: suggestionRef.current || undefined }
  }

  const doTest = async () => {
    const pattern = buildPattern()
    if (!pattern) return
    const raw = (form.getFieldValue('samples') || '').trim()
    const samples = raw.split('\n').map((s) => s.trim()).filter(Boolean)
    if (!samples.length) return
    setTesting(true)
    try {
      const res = await testRule(pattern, samples)
      setTestResults(res)
    } catch {
      // 拦截器已 toast（400：正则非法/样例为空）
    } finally {
      setTesting(false)
    }
  }

  const doSave = async () => {
    const v = await form.validateFields()
    const pattern = buildPattern()
    if (!pattern) return
    setSaving(true)
    try {
      const payload = {
        title: v.title.trim(),
        description: v.description?.trim() || null,
        naturalPrompt: v.naturalPrompt?.trim() || '',
        kind: drawerKind,
        contractTypes: v.contractTypes || [],
        pattern,
      }
      if (editing) await updateRule(editing.id, payload)
      else await createRule(payload)
      setDrawerOpen(false)
    } catch {
      // 校验/接口错误已提示
    } finally {
      setSaving(false)
    }
  }

  const doEnablePack = async (code) => {
    setEnabling(true)
    try {
      const res = await enablePack(code)
      if (res.copied > 0) setTab('FORBIDDEN')
    } finally {
      setEnabling(false)
    }
  }

  const renderRuleTable = (list) => (
    <div className={css.panel}>
      <div className={css.panelHead}>
        <h3>{tab === 'FORBIDDEN' ? '红线规则' : '偏好口径'}</h3>
        <span className={shared.small + ' ' + shared.muted}>
          {tab === 'FORBIDDEN' ? '命中即判高风险，审批时强制提示' : '不违规但希望统一的谈判口径，命中给修改建议'}
        </span>
      </div>
      {list.length === 0 ? (
        <div style={{ padding: '36px 0' }}>
          <Empty description={tab === 'FORBIDDEN' ? '还没有红线规则，点击右上角「新建规则」或启用行业包' : '还没有偏好口径规则'} />
        </div>
      ) : (
        <table className={shared.tbl}>
          <thead>
            <tr>
              <th>规则名称</th><th style={{ width: 130 }}>适用类型</th>
              <th style={{ width: 110 }}>近 30 天命中</th><th style={{ width: 80 }}>状态</th>
              <th style={{ width: 130 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>
                  <b>{r.title}</b>
                  {r.description && <div className={css.cellSub}>{r.description}</div>}
                  {r.source === 'SEED_PACK' && (
                    <span className={`${shared.tag} ${shared.tagPurple}`} style={{ marginTop: 4 }}>行业包</span>
                  )}
                </td>
                <td>{typeTags(r.contractTypes)}</td>
                <td><b>{r.hit30d} 次</b></td>
                <td>
                  <Switch
                    size="small" checked={r.enabled}
                    onChange={(checked) => toggleRule(r.id, checked)}
                  />
                </td>
                <td className={css.rowActions}>
                  <button className={css.linkBtn} onClick={() => openEdit(r)}>编辑</button>
                  <Popconfirm
                    title="删除该规则？" description="删除后对新发起的审查立即失效，历史命中记录保留。"
                    okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
                    transitionName="" maskTransitionName=""
                    onConfirm={() => deleteRule(r.id)}
                  >
                    <button className={`${css.linkBtn} ${css.linkDanger}`}>删除</button>
                  </Popconfirm>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )

  const renderStandard = () => (
    <div className={css.panel}>
      <div className={css.panelHead}>
        <h3>标准合同库</h3>
        <Tooltip title="标准合同 AI 抽取规则草稿即将上线">
          <Button icon={<UploadOutlined />} disabled>上传标准合同</Button>
        </Tooltip>
      </div>
      <div style={{ padding: '40px 0' }}>
        <Empty description="上传公司标准合同，自动抽取规则草稿（即将上线）">
          <span className={`${shared.tag} ${shared.tagGray}`}>标准合同规则自动抽取 · 即将上线</span>
        </Empty>
      </div>
    </div>
  )

  const renderPacks = () => (
    <div className={css.packGrid}>
      {packs.map((p) => {
        const monthHits = p.enabled
          ? rules.filter((r) => r.source === 'SEED_PACK' && redlineRules.concat(prefRules).some((x) => x.id === r.id))
            .reduce((s, r) => s + (r.hit30d || 0), 0)
          : 0
        return (
          <div key={p.code} className={`${css.packCard} ${p.live ? css.packLive : ''}`}>
            <div className={css.packHead}>
              <span className={css.packLogo}><ApiOutlined /></span>
              <div>
                <b style={{ fontSize: 15 }}>{p.name}</b>
                <div className={`${shared.small} ${shared.muted}`}>{p.team} · {p.ruleCount} 条规则</div>
              </div>
              <span className={`${shared.tag} ${p.enabled ? shared.tagGreen : shared.tagGray}`} style={{ marginLeft: 'auto' }}>
                {p.live ? (p.enabled ? '已启用' : '未启用') : '即将上线'}
              </span>
            </div>
            <div className={`${shared.small} ${shared.muted}`}>{p.desc}</div>
            <ul className={css.packList}>
              {p.features.map((f) => <li key={f}>{f}</li>)}
            </ul>
            <div className={css.packFoot}>
              {!p.live
                ? <Button size="small" disabled>即将上线，敬请期待</Button>
                : p.enabled
                  ? <>
                      <Button size="small" onClick={() => setTab('FORBIDDEN')}>管理规则</Button>
                      <span className={`${shared.tag} ${shared.tagGray}`}>本月命中 {monthHits} 次</span>
                    </>
                  : <Button size="small" type="primary" loading={enabling} onClick={() => doEnablePack(p.code)}>
                      一键启用（{p.ruleCount} 条规则）
                    </Button>}
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <Spin spinning={loading && isTeamSpace} tip="加载规则中…">
      {/* 工具栏 */}
      <div className={css.toolbar}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20 }}>审查规则 Playbook</h2>
          <p className={shared.muted} style={{ margin: '4px 0 0' }}>把公司内部的合规标准变成 AI 的审查口径</p>
        </div>
        <div className={css.toolRight}>
          <Tooltip title="标准合同 AI 抽取规则草稿即将上线">
            <Button icon={<UploadOutlined />} disabled>上传标准合同</Button>
          </Tooltip>
          <Button
            type="primary" icon={<PlusOutlined />}
            onClick={() => openCreate(tab === 'PREFERENCE' ? 'PREFERENCE' : 'FORBIDDEN')}
          >
            新建规则
          </Button>
        </div>
      </div>

      {/* 价值 banner */}
      <div className={css.banner}>
        <span className={css.bico}><SafetyCertificateFilled /></span>
        <div>
          <b>把公司的合规红线、禁止条款与标准合同沉淀在这里</b>，每份合同都会优先按公司口径审查；规则越用越准，团队的审查标准就越离不开 WorkMind。
          <div className={`${shared.small} ${shared.muted}`} style={{ marginTop: 3 }}>
            红线命中直接判高风险；偏好口径用于修改建议；标准合同自动抽取规则草稿；行业包一键启用整组规则。
          </div>
        </div>
      </div>

      {/* 四分区 */}
      <div className={css.seg}>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`${css.segItem} ${tab === t.key ? css.segOn : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'FORBIDDEN' && renderRuleTable(redlineRules)}
      {tab === 'PREFERENCE' && renderRuleTable(prefRules)}
      {tab === 'STANDARD' && renderStandard()}
      {tab === 'PACK' && renderPacks()}

      {/* 新建 / 编辑规则抽屉 */}
      <Drawer
        width={720}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{editing ? '编辑规则' : '新建规则'}</div>
            <div className={`${shared.small} ${shared.muted}`}>{KIND_META[drawerKind].drawer}</div>
          </div>
        }
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button onClick={() => setDrawerOpen(false)} style={{ marginRight: 8 }}>取消</Button>
            <Button type="primary" loading={saving} onClick={doSave}>保存规则</Button>
          </div>
        }
        transitionName="" maskTransitionName=""
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="规则名称" name="title" rules={[{ required: true, message: '请输入规则名称' }, { max: 200 }]}>
            <Input placeholder="如：违约金不得超过合同总额 20%" />
          </Form.Item>

          <Form.Item label="适用合同类型（多选）" name="contractTypes">
            <Checkbox.Group options={TYPE_OPTIONS} />
          </Form.Item>

          <Form.Item label="规则描述" name="description">
            <TextArea rows={2} placeholder="一句话说明这条规则管什么、命中后应该怎么处理" />
          </Form.Item>

          <Form.Item label="自然语言描述" name="naturalPrompt">
            <TextArea rows={3} placeholder="如：违约金不得超过合同总额的 20%，超出部分不予支持" />
          </Form.Item>
          <div style={{ marginTop: -12, marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Button type="primary" size="small" loading={parsing} onClick={doParse}>
              <span className={`${shared.tag} ${shared.tagPurple}`} style={{ marginRight: 6 }}>AI</span>
              AI 转为结构化规则
            </Button>
            <span className={`${shared.small} ${shared.muted}`}>AI 生成关键词与匹配条件，可人工修改后再生效</span>
          </div>

          <div className={css.aiBox}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <span className={`${shared.tag} ${shared.tagPurple}`}>AI</span>
              <b style={{ fontSize: 14 }}>结构化规则</b>
              <span className={`${shared.small} ${shared.muted}`} style={{ marginLeft: 'auto' }}>可编辑，以保存内容为准</span>
            </div>

            <Form.Item label="关键词（逗号分隔）" name="keywords">
              <Input placeholder="违约金，20%，总额，超过" />
            </Form.Item>
            <Form.Item
              label="正则 / 匹配条件" name="regex"
              extra="条件可手写：未配置模型 Key 时也能直接保存并参与规则引擎审查。"
              rules={[{ validator: (_r, v) => (!v ? Promise.resolve() : (() => { try { new RegExp(v, 'm'); return Promise.resolve() } catch (e) { return Promise.reject(new Error('正则不合法：' + e.message)) } })()) }]}
            >
              <Input placeholder="可选；留空时按关键词全部出现判定命中" />
            </Form.Item>
            <Form.Item label="风险等级" name="severity">
              <Select style={{ width: 200 }} options={[
                { value: 'HIGH', label: '高风险（红线）' },
                { value: 'MED', label: '中风险' },
                { value: 'LOW', label: '低风险（仅提示）' },
              ]} />
            </Form.Item>

            <div style={{ borderTop: '1px dashed var(--color-border)', margin: '16px 0' }} />

            <Form.Item
              label="样例测试（每条一行）" name="samples"
              extra="可加「样例①：」前缀；逐行返回命中 / 不命中"
            >
              <TextArea rows={4} placeholder={'样例①：……应支付违约金，标准超过合同总额的 20%，按 30% 计。\n样例②：违约金数额不超过合同总额的 20%，超出部分不予支持。'} />
            </Form.Item>
            <Button size="small" loading={testing} onClick={doTest}>测试命中</Button>

            {testResults && (
              <div className={css.testBox}>
                {testResults.regexError && (
                  <div className={css.testError}>正则错误：{testResults.regexError}</div>
                )}
                {testResults.results.map((r, i) => (
                  <div key={i} className={css.testRow}>
                    {r.hit
                      ? <span className={`${shared.tag} ${shared.tagGreen}`}>样例{i + 1}命中 · {r.mode === 'pattern' ? '正则' : '关键词'}{form.getFieldValue('severity') === 'HIGH' ? ' · 高风险（红线）' : ''}</span>
                      : <span className={`${shared.tag} ${shared.tagGray}`}>样例{i + 1}未命中</span>}
                    {r.matches[0] && <span className={`${shared.small} ${shared.muted}`}>「{r.matches[0].slice(0, 40)}」</span>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={shared.bannerWarn} style={{ marginTop: 16 }}>
            未配置模型 Key 时可直接手写关键词与条件，不影响规则生效；AI 转换仅用于提升配置效率。
          </div>
        </Form>
      </Drawer>
    </Spin>
  )
}
