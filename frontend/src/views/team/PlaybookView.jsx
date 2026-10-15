// frontend/src/views/team/PlaybookView.jsx
// 企业 Playbook 审查规则（FR-17，文案对齐 docs/prototype/playbook.html）：
// 红线规则 / 偏好口径 / 标准合同库（跳转范本提炼）/ 行业专项包。
// 规则列表带来源标注：AI 提炼（含来源范本标题，可溯源）/ 行业包 / 手动创建（无标签）。
// 规则编辑：标题 + 合同类型（下拉）+ 规则内容（完整句子）；
// 机器命中条件（关键词/阈值正则）保存时由 AI 按内容句静默自动生成，界面对用户不可见，无 Key 时整句兜底。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Drawer, Empty, Form, Input, Popconfirm, Select, Spin, Switch, Tooltip, message,
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
  { label: '劳动', value: 'LABOR' },
  { label: '实习', value: 'INTERNSHIP' },
  { label: '劳务/兼职', value: 'SERVICE' },
  { label: '租赁', value: 'LEASE' },
  { label: '保密 NDA', value: 'NDA' },
  { label: '买卖', value: 'SALE' },
  { label: '借款', value: 'LOAN' },
  { label: '股权转让', value: 'EQUITY' },
  { label: '非标', value: 'CUSTOM' },
  { label: '通用', value: 'ALL' },
]
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))
const TYPE_TAG_CLASS = {
  LABOR: shared.tagBlue, INTERNSHIP: shared.tagBlue,
  SERVICE: shared.tagOrange, LEASE: shared.tagOrange, NDA: shared.tagOrange,
  SALE: shared.tagOrange, LOAN: shared.tagOrange, EQUITY: shared.tagOrange,
  CUSTOM: shared.tagGray, ALL: shared.tagPurple,
}

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

/** 类型数组 → 缓存键（顺序无关） */
const typesKeyOf = (types) => (types || []).slice().sort().join(',')

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
    parseRule, enablePack,
  } = usePlaybookStore()

  const [tab, setTab] = useState('FORBIDDEN')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [editing, setEditing] = useState(null) // null=新建；rule 对象=编辑
  const [drawerKind, setDrawerKind] = useState('FORBIDDEN')
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)
  const [enabling, setEnabling] = useState(false)
  // 保存时静默调 AI 生成机器命中条件；同内容+同类型复用上次结果（编辑未改内容时不重复消耗）
  const [parsing, setParsing] = useState(false)
  const patternCacheRef = useRef(null) // { content, typesKey, pattern }

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

  /** 规则的完整内容句：早期数据可能只有留痕文案/描述，均缺失时回落到标题 */
  const ruleContentOf = (rule) => {
    const p = (rule.naturalPrompt || '').trim()
    if (p && !p.startsWith('从企业范本')) return p
    return (rule.description || '').trim() || rule.title
  }

  /** 列表副标题：仅在有真实内容句/描述时展示，避免与标题重复 */
  const ruleSubText = (rule) => {
    const p = (rule.naturalPrompt || '').trim()
    if (p && !p.startsWith('从企业范本')) return p
    return (rule.description || '').trim() || null
  }

  const openCreate = (kind) => {
    setEditing(null)
    setDrawerKind(kind)
    form.resetFields()
    form.setFieldsValue({ contractType: ['ALL'] })
    patternCacheRef.current = null
    setDrawerOpen(true)
  }

  /** 「通用」与具体类型互斥：同时出现时按用户本次新增的项保留 */
  const handleTypesChange = (next) => {
    const specifics = next.filter((v) => v !== 'ALL')
    const hasAll = next.includes('ALL')
    if (hasAll && specifics.length) {
      const prev = form.getFieldValue('contractType') || []
      form.setFieldsValue({ contractType: prev.includes('ALL') ? specifics : ['ALL'] })
      return
    }
    if (!next.length) form.setFieldsValue({ contractType: ['ALL'] })
  }

  const openEdit = (rule) => {
    setEditing(rule)
    setDrawerKind(rule.kind)
    form.resetFields()
    // 空数组或含 ALL 均视为全类型；其余原样回显（支持一条规则适用多个类型）
    const types = rule.contractTypes || []
    const contractType = !types.length || types.includes('ALL') ? ['ALL'] : types
    const content = ruleContentOf(rule)
    form.setFieldsValue({ title: rule.title, contractType, content })
    // 预填缓存：只改标题/类型且内容未动时，保存直接沿用原命中条件，不重复调 AI
    const p = rule.pattern || {}
    patternCacheRef.current = (p.keywords?.length || p.regex)
      ? {
          content,
          typesKey: typesKeyOf(contractType),
          pattern: {
            keywords: p.keywords || [],
            regex: p.regex || null,
            severity: p.severity || KIND_META[rule.kind].defaultSeverity,
            ...(p.suggestion ? { suggestion: p.suggestion } : {}),
          },
        }
      : null
    setDrawerOpen(true)
  }

  /**
   * 保存时由规则内容句静默生成机器命中条件：
   * 内容+类型与缓存一致 → 复用；否则调 AI 重新生成；未配置 Key → 整句子串匹配兜底。
   */
  const generatePattern = async (content, types) => {
    const cache = patternCacheRef.current
    const typesKey = typesKeyOf(types)
    if (cache && cache.content === content && cache.typesKey === typesKey) return cache.pattern
    setParsing(true)
    let pattern
    try {
      const res = await parseRule(content, types.includes('ALL') ? [] : types)
      pattern = {
        keywords: res.pattern.keywords || [],
        regex: res.pattern.regex || null,
        severity: res.pattern.severity || KIND_META[drawerKind].defaultSeverity,
        ...(res.pattern.suggestion ? { suggestion: res.pattern.suggestion } : {}),
      }
    } catch {
      // 409=未配置 Key：用规则整句做精确子串匹配兜底，不阻塞保存
      pattern = { keywords: [content.slice(0, 200)], regex: null, severity: KIND_META[drawerKind].defaultSeverity }
      message.warning('未配置 AI 模型，暂按规则整句精确匹配兜底；配置模型 Key 后可自动生成关键词与阈值识别')
    } finally {
      setParsing(false)
    }
    patternCacheRef.current = { content, typesKey, pattern }
    return pattern
  }

  const doSave = async () => {
    const v = await form.validateFields()
    const content = (v.content || '').trim()
    if (content.length < 4) {
      form.setFields([{ name: 'content', errors: ['请用完整的话写明规则内容（至少 4 个字）'] }])
      return
    }
    setSaving(true)
    try {
      const types = (v.contractType || []).length ? v.contractType : ['ALL']
      const pattern = await generatePattern(content, types)
      if (!pattern.keywords.length && !pattern.regex) {
        message.error('规则匹配条件生成失败，请调整规则内容表述后重试')
        return
      }
      const payload = {
        title: v.title.trim(),
        kind: drawerKind,
        // 选「通用」存空数组（引擎口径：空=全类型），其余存所选类型数组（支持多选）
        contractTypes: types.includes('ALL') ? [] : types,
        // 规则内容句留痕，编辑时也作为回显来源
        naturalPrompt: content,
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
                  {ruleSubText(r) && <div className={css.cellSub}>{ruleSubText(r)}</div>}
                  {r.source === 'AI' && (
                    <Tooltip title={r.sourceLabel
                      ? `由 AI 从企业范本《${r.sourceLabel}》提炼，导入前经人工确认`
                      : '由 AI 从企业范本提炼，导入前经人工确认'}
                    >
                      <span className={`${shared.tag} ${shared.tagBlue}`} style={{ marginTop: 4 }}>
                        AI 提炼{r.sourceLabel ? ` · ${r.sourceLabel.length > 12 ? r.sourceLabel.slice(0, 12) + '…' : r.sourceLabel}` : ''}
                      </span>
                    </Tooltip>
                  )}
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
        <Button type="primary" icon={<UploadOutlined />} onClick={() => navigate('/templates?tab=mine')}>
          上传 / 管理标准合同
        </Button>
      </div>
      <div style={{ padding: '40px 0' }}>
        <Empty
          description={(
            <span>
              标准合同库已与「合同范本」打通：在 <b>合同范本 → 我的范本</b> 上传公司标准合同，
              <br />即可用 AI 自动抽取规则草稿，勾选后导入红线规则（规则会标注来源范本，方便溯源）。
            </span>
          )}
        >
          <Button type="primary" ghost onClick={() => navigate('/templates?tab=mine')}>从范本提炼规则</Button>
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
          <Tooltip title="上传公司标准合同范本，AI 提炼候选规则，人工确认后导入">
            <Button icon={<UploadOutlined />} onClick={() => navigate('/templates?tab=mine')}>
              从范本提炼
            </Button>
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
          <b>把公司的合规红线、禁止条款与标准合同沉淀在这里</b>，每份合同都会优先按公司口径审查；规则越用越准，团队的审查标准就越离不开 ClauseMind。
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
        width={460}
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
            <Button type="primary" loading={saving || parsing} onClick={doSave}>保存规则</Button>
          </div>
        }
        transitionName="" maskTransitionName=""
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item label="规则标题" name="title" rules={[{ required: true, message: '请输入规则标题' }, { max: 200 }]}>
            <Input placeholder="如：加班时长上限" />
          </Form.Item>

          <Form.Item
            label="适用合同类型"
            name="contractType"
            rules={[{ required: true, message: '请选择适用的合同类型' }]}
            extra="可多选：该规则将对所选类型的合同生效；选「通用」表示所有类型都适用"
          >
            <Select
              mode="multiple"
              maxTagCount="responsive"
              placeholder="可多选，例如同时适用于劳动合同与保密协议"
              options={TYPE_OPTIONS}
              showSearch
              optionFilterProp="label"
              onChange={handleTypesChange}
            />
          </Form.Item>

          <Form.Item
            label="规则内容"
            name="content"
            rules={[{ required: true, message: '请填写规则内容' }]}
            extra="用完整、通顺的一句话写清规则要求（谁应当/不得怎么做、具体阈值是多少）。保存后系统会自动按此内容识别合同中的相关条款。"
          >
            <TextArea rows={5} placeholder={'例如：每月加班时间不得超过 36 小时，超过部分应依法支付加班费。'} />
          </Form.Item>
        </Form>
      </Drawer>
    </Spin>
  )
}
