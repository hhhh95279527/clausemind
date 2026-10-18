// frontend/src/views/team/MyTemplatesPanel.jsx
// 租户自有合同范本库（个人/团队空间通用）：
//   上传文字版 Word/PDF/TXT/MD → 列表/预览/删除 → AI 提炼候选审查规则
//   候选必须人工勾选/编辑/样例测试后才导入 Playbook（source=AI，导入即启用）。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Alert, Button, Checkbox, Collapse, Drawer, Empty, Input, Modal, Popconfirm, Select, Spin, Table, Tag, Upload,
  message,
} from 'antd'
import {
  DeleteOutlined, EditOutlined, EyeOutlined, FileTextOutlined, ImportOutlined,
  RobotOutlined, UploadOutlined,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import { useMeStore } from '@/stores/me.js'
import { useTenantTemplateStore } from '@/stores/tenant-template.js'
import css from './templates.module.css'

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

const ACCEPT = '.docx,.pdf,.txt,.md'
const MAX_MB = 30

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

export default function MyTemplatesPanel() {
  const navigate = useNavigate()
  const isTeamSpace = useMeStore((s) => s.entitlement?.workspaceType) === 'TEAM'
  const { templates, limit, loading, uploading, load, upload, detail, update, remove, extractRules, importRules } =
    useTenantTemplateStore()

  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  // 编辑弹窗：{ id, title, content, loading, saving }
  const [editing, setEditing] = useState(null)

  // 提炼向导状态
  const [wizardTpl, setWizardTpl] = useState(null)
  const [focus, setFocus] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [candidates, setCandidates] = useState([])
  const [testingKey, setTestingKey] = useState(null)
  const [testMap, setTestMap] = useState({})
  const [importing, setImporting] = useState(false)

  useEffect(() => { load() }, [load])

  const reachLimit = templates.length >= limit

  const uploadProps = {
    accept: ACCEPT,
    multiple: false,
    showUploadList: false,
    beforeUpload: (file) => {
      const isOk = /\.(docx|pdf|txt|md)$/i.test(file.name)
      if (!isOk) { message.error('仅支持文字版 Word（.docx）/ PDF / TXT / Markdown'); return Upload.LIST_IGNORE }
      if (file.size > MAX_MB * 1024 * 1024) { message.error(`文件不能超过 ${MAX_MB}MB`); return Upload.LIST_IGNORE }
      upload(file, '')
        .then((t) => message.success(`范本「${t.title}」已上传并解析完成`))
        .catch((e) => message.error(e.message || '上传失败'))
      return false // 阻止 antd 自动上传，统一走 store XHR
    },
  }

  const openPreview = async (row) => {
    setPreview({ title: row.title, content: '', meta: row })
    setPreviewLoading(true)
    try {
      const data = await detail(row.id)
      setPreview({ title: row.title, content: data.template.content, meta: row })
    } finally {
      setPreviewLoading(false)
    }
  }

  const onRemove = async (row) => {
    try {
      await remove(row.id)
      message.success('范本已删除')
      if (preview?.meta?.id === row.id) setPreview(null)
    } catch (e) {
      message.error(e.response?.data?.error?.message || '删除失败')
    }
  }

  // 编辑：列表项不含正文，先拉详情再弹窗
  const openEdit = async (row) => {
    setEditing({ id: row.id, title: row.title, content: '', loading: true, saving: false })
    try {
      const data = await detail(row.id)
      setEditing({
        id: row.id,
        title: data.template.title,
        content: data.template.content,
        loading: false,
        saving: false,
      })
    } catch (e) {
      message.error(e.response?.data?.error?.message || '加载范本失败')
      setEditing(null)
    }
  }

  const closeEdit = () => {
    if (editing?.saving) return
    setEditing(null)
  }

  const saveEdit = async () => {
    const title = editing.title.trim()
    const content = editing.content.trim()
    if (!title) { message.warning('请填写范本名称'); return }
    if (!content) { message.warning('范本正文不能为空'); return }
    setEditing((e) => ({ ...e, saving: true }))
    try {
      const saved = await update(editing.id, { title, content })
      message.success('范本已更新')
      // 预览抽屉正开着同一篇时同步内容，避免展示旧文本
      setPreview((p) => (p && p.meta?.id === saved.id ? { ...p, title: saved.title, content } : p))
      setEditing(null)
    } catch (e) {
      message.error(e.response?.data?.error?.message || '保存失败')
      setEditing((e2) => (e2 ? { ...e2, saving: false } : e2))
    }
  }

  const openWizard = (row) => {
    setWizardTpl(row)
    setFocus('')
    setCandidates([])
    setTestMap({})
  }

  const closeWizard = () => {
    if (extracting || importing) return
    setWizardTpl(null)
  }

  const doExtract = async () => {
    setExtracting(true)
    setCandidates([])
    setTestMap({})
    try {
      const data = await extractRules(wizardTpl.id, focus.trim())
      const list = (data.rules || []).map((r, i) => ({
        key: `${i}`,
        checked: true,
        title: r.title,
        content: r.content || r.title || '',
        kind: r.kind,
        contractTypes: r.contractTypes?.length ? r.contractTypes : ['ALL'],
        keywordsText: (r.keywords || []).join('，'),
        regex: r.regex || '',
        severity: r.severity,
        suggestion: r.suggestion || '',
        evidence: r.evidence || '',
      }))
      setCandidates(list)
      if (!list.length) message.warning('AI 未提炼出可靠规则，可换个提炼重点重试')
    } catch (e) {
      // 429/503/403 等已由拦截器统一 toast；这里兜底网络层错误
      if (!e.response) message.error(e.message || '提炼失败，请稍后重试')
    } finally {
      setExtracting(false)
    }
  }

  const patchCandidate = (key, patch) => {
    setCandidates((cs) => cs.map((c) => (c.key === key ? { ...c, ...patch } : c)))
  }

  const doTest = async (c) => {
    const keywords = c.keywordsText.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
    const regex = c.regex.trim() || null
    if (!keywords.length && !regex) { message.warning('请先填写关键词或正则'); return }
    setTestingKey(c.key)
    try {
      const data = await http.post('/playbook/rules/test', {
        pattern: { regex, keywords },
        samples: [c.evidence || '（缺少依据原句，请手动补充样例）'],
      })
      setTestMap((m) => ({ ...m, [c.key]: data.results?.[0] || null }))
    } finally {
      setTestingKey(null)
    }
  }

  const checkedCount = useMemo(() => candidates.filter((c) => c.checked).length, [candidates])

  const doImport = async () => {
    const picked = candidates.filter((c) => c.checked)
    if (!picked.length) { message.warning('请至少勾选一条规则'); return }
    const rules = picked.map((c) => ({
      title: c.title.trim(),
      content: c.content.trim(),
      kind: c.kind,
      contractTypes: c.contractTypes.length ? c.contractTypes : ['ALL'],
      keywords: c.keywordsText.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean),
      regex: c.regex.trim() || null,
      severity: c.severity,
      suggestion: c.suggestion.trim(),
    }))
    if (rules.some((r) => !r.title || !r.content)) {
      message.warning('勾选的规则中存在标题或规则内容为空的项，请补全或取消勾选')
      return
    }
    if (rules.some((r) => !r.keywords.length && !r.regex)) {
      message.warning('勾选的规则中存在命中条件（关键词/正则）为空的项，请展开高级区补全或取消勾选')
      return
    }
    setImporting(true)
    try {
      const data = await importRules(wizardTpl.id, rules)
      message.success(`已导入 ${data.imported} 条规则，保存后立即对新审查生效`)
      setWizardTpl(null)
    } catch (e) {
      if (!e.response) message.error(e.message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const columns = [
    {
      title: '范本',
      dataIndex: 'title',
      render: (title, row) => (
        <div className={css.tplCell}>
          <FileTextOutlined className={css.tplCellIcon} />
          <div>
            <b>{title}</b>
            <div className={css.tplCellSub}>{row.fileName}</div>
          </div>
        </div>
      ),
    },
    { title: '字数', dataIndex: 'charCount', width: 100, render: (n) => n.toLocaleString('zh-CN') },
    { title: '大小', dataIndex: 'fileSize', width: 90, render: (n) => fmtSize(n) },
    {
      title: '上传时间', dataIndex: 'createdAt', width: 120,
      render: (t) => String(t).slice(0, 10),
    },
    {
      title: '操作', width: 300,
      render: (_, row) => (
        <div className={css.rowActions}>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openPreview(row)}>预览</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>
          <Button size="small" type="primary" ghost icon={<RobotOutlined />} onClick={() => openWizard(row)}>
            提炼规则
          </Button>
          <Popconfirm title="删除该范本？已导入的规则会保留" okText="删除" cancelText="取消" onConfirm={() => onRemove(row)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </div>
      ),
    },
  ]

  return (
    <div>
      <div className={css.myHead}>
        <div className={css.myHint}>
          {isTeamSpace ? '上传公司标准合同范本' : '上传你常用的合同范本'}
          （文字版 Word/PDF/TXT，≤{MAX_MB}MB），AI 可从中提炼个性化审查规则；
          <b> 提炼结果需人工勾选确认后才会生效</b>。已存 {templates.length}/{limit} 份。
        </div>
        <Upload {...uploadProps} disabled={reachLimit || uploading}>
          <Button type="primary" icon={<UploadOutlined />} loading={uploading} disabled={reachLimit}>
            上传范本
          </Button>
        </Upload>
      </div>
      {reachLimit && <div className={css.myLimitWarn}>已达 {limit} 份上限，请先删除不用的范本。</div>}

      <Spin spinning={loading}>
        {templates.length === 0 && !loading ? (
          <Empty
            className={css.myEmpty}
            description={isTeamSpace
              ? '还没有企业范本，上传一份公司标准合同试试（建议使用文字版 .docx）'
              : '还没有范本，上传一份你常用的合同试试（建议使用文字版 .docx）'}
          />
        ) : (
          <Table
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={templates}
            pagination={false}
          />
        )}
      </Spin>

      {/* 范本全文预览 */}
      <Drawer
        open={!!preview}
        onClose={() => setPreview(null)}
        width={600}
        title={preview?.title}
        destroyOnClose
        extra={
          preview?.meta && (
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(preview.meta)}>编辑</Button>
          )
        }
      >
        {previewLoading ? (
          <div className={css.myCenter}><Spin tip="加载全文…" /></div>
        ) : (
          <pre className={css.myPreview}>{preview?.content}</pre>
        )}
      </Drawer>

      {/* 编辑范本：标题 + 正文（只改在线文本，不动原始文件） */}
      <Modal
        open={!!editing}
        title={isTeamSpace ? '编辑企业范本' : '编辑范本'}
        width={760}
        destroyOnClose
        maskClosable={false}
        okText="保存"
        cancelText="取消"
        confirmLoading={editing?.saving}
        onOk={saveEdit}
        onCancel={closeEdit}
      >
        {editing?.loading ? (
          <div className={css.myCenter}><Spin tip="加载范本全文…" /></div>
        ) : (
          <div className={css.myEditBody}>
            <Alert
              type="info"
              showIcon
              message="仅修改在线文本：在线预览与「AI 提炼规则」以修改后的正文为准，不会改动原始上传文件。"
              description="如需替换原始文件（如换了新版 Word），请删除本范本后重新上传。"
            />
            <div>
              <div className={css.candLabel}>范本名称</div>
              <Input
                value={editing?.title || ''}
                maxLength={200}
                showCount
                placeholder="给这份范本起个名字"
                onChange={(e) => setEditing((x) => (x ? { ...x, title: e.target.value } : x))}
              />
            </div>
            <div>
              <div className={css.candLabel}>
                范本正文
                <span className={css.myEditCount}>{(editing?.content || '').length.toLocaleString('zh-CN')} 字</span>
              </div>
              <TextArea
                rows={18}
                value={editing?.content || ''}
                placeholder="粘贴或直接修改范本正文…"
                onChange={(e) => setEditing((x) => (x ? { ...x, content: e.target.value } : x))}
                className={css.myEditText}
              />
            </div>
          </div>
        )}
      </Modal>

      {/* AI 提炼规则向导 */}
      <Drawer
        open={!!wizardTpl}
        onClose={closeWizard}
        width={760}
        title={wizardTpl ? `从范本提炼规则 · ${wizardTpl.title}` : ''}
        destroyOnClose
        maskClosable={false}
        footer={<div className={css.myWizardFoot}>
          <span className={css.myCheckedInfo}>
            {candidates.length > 0 && `已勾选 ${checkedCount} / ${candidates.length} 条`}
          </span>
          <div>
            <Button onClick={closeWizard} style={{ marginRight: 8 }} disabled={importing}>取消</Button>
            <Button
              type="primary"
              icon={<ImportOutlined />}
              loading={importing}
              disabled={!checkedCount}
              onClick={doImport}
            >
              导入已勾选规则
            </Button>
            <Button type="link" onClick={() => navigate('/playbook')}>
              前往规则库查看
            </Button>
          </div>
        </div>}
      >
        <div className={css.myFocusRow}>
          <TextArea
            rows={2}
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            placeholder="提炼重点（可选），如：付款节点与逾期违约责任；留空则从全文提炼个性化规则"
            maxLength={500}
          />
          <Button
            type="primary"
            icon={<RobotOutlined />}
            loading={extracting}
            onClick={doExtract}
            block
          >
            {extracting ? 'AI 提炼中，约需 10~30 秒…' : candidates.length ? '重新提炼' : '开始 AI 提炼'}
          </Button>
        </div>

        {extracting && (
          <div className={css.myCenter}><Spin tip="正在通读范本并提炼规则…" /></div>
        )}

        {!extracting && candidates.length === 0 && (
          <Empty
            className={css.myCenter}
            description="填写提炼重点后点击「开始 AI 提炼」，候选规则将在此逐条列出，可编辑、测试后再导入"
          />
        )}

        {!extracting && candidates.map((c) => {
          const tr = testMap[c.key]
          return (
            <div key={c.key} className={`${css.candCard} ${c.checked ? '' : css.candCardOff}`}>
              <div className={css.candHead}>
                <Checkbox checked={c.checked} onChange={(e) => patchCandidate(c.key, { checked: e.target.checked })}>
                  <Input
                    variant="borderless"
                    value={c.title}
                    onChange={(e) => patchCandidate(c.key, { title: e.target.value })}
                    className={css.candTitleInput}
                  />
                </Checkbox>
                <Tag color={c.severity === 'HIGH' ? 'red' : c.severity === 'MED' ? 'orange' : 'default'}>
                  {c.severity === 'HIGH' ? '高风险' : c.severity === 'MED' ? '中风险' : '低风险'}
                </Tag>
              </div>

              <div className={css.candRow}>
                <span className={css.candLabel}>类型</span>
                <Select
                  size="small"
                  style={{ width: 130 }}
                  value={c.kind}
                  onChange={(kind) => patchCandidate(c.key, { kind })}
                  options={[
                    { value: 'FORBIDDEN', label: '红线规则' },
                    { value: 'PREFERENCE', label: '偏好口径' },
                  ]}
                />
                <span className={css.candLabel}>文档类型</span>
                <Select
                  size="small"
                  style={{ width: 130 }}
                  value={c.contractTypes[0] || 'ALL'}
                  onChange={(v) => patchCandidate(c.key, { contractTypes: [v] })}
                  options={TYPE_OPTIONS}
                  showSearch
                  optionFilterProp="label"
                />
                <span className={css.candLabel}>等级</span>
                <Select
                  size="small"
                  style={{ width: 90 }}
                  value={c.severity}
                  onChange={(severity) => patchCandidate(c.key, { severity })}
                  options={[
                    { value: 'HIGH', label: '高' }, { value: 'MED', label: '中' }, { value: 'LOW', label: '低' },
                  ]}
                />
              </div>

              <div className={css.candField}>
                <div className={css.candLabel}>规则内容（完整的一句话，可直接编辑）</div>
                <TextArea
                  rows={3}
                  value={c.content}
                  onChange={(e) => patchCandidate(c.key, { content: e.target.value })}
                  placeholder="用完整的话写清规则要求与具体阈值"
                />
              </div>
              {c.evidence && (
                <div className={css.candEvidence}>
                  <span className={css.candLabel}>范本依据：</span>「{c.evidence}」
                </div>
              )}

              <Collapse
                ghost
                size="small"
                style={{ marginLeft: -10 }}
                items={[{
                  key: 'adv',
                  label: `命中条件与修改建议（AI 已生成${c.regex ? '关键词+阈值正则' : '关键词'}，一般无需修改）`,
                  children: (
                    <>
                      <div className={css.candField}>
                        <div className={css.candLabel}>关键词（逗号分隔，需全部出现才命中）</div>
                        <TextArea
                          rows={2}
                          value={c.keywordsText}
                          onChange={(e) => patchCandidate(c.key, { keywordsText: e.target.value })}
                          placeholder="AI 自动生成的事实词"
                        />
                      </div>
                      <div className={css.candField}>
                        <div className={css.candLabel}>正则（数字阈值类规则 AI 自动生成，精确识别超限写法）</div>
                        <Input
                          size="small"
                          value={c.regex}
                          onChange={(e) => patchCandidate(c.key, { regex: e.target.value })}
                          placeholder="不含两侧斜杠"
                        />
                      </div>
                      <div className={css.candField}>
                        <div className={css.candLabel}>命中后修改建议</div>
                        <TextArea
                          rows={2}
                          value={c.suggestion}
                          onChange={(e) => patchCandidate(c.key, { suggestion: e.target.value })}
                        />
                      </div>
                      <div className={css.candTestRow}>
                        <Button size="small" loading={testingKey === c.key} onClick={() => doTest(c)}>
                          用依据原句样例测试
                        </Button>
                        {tr && (
                          tr.hit ? (
                            <Tag color="green">样例命中 · {tr.mode === 'pattern' ? '正则' : '关键词'}</Tag>
                          ) : (
                            <span className={css.candMiss}>
                              <Tag color="default">样例未命中</Tag>
                              {tr.regexMissed ? '正则未匹配到内容' : ''}
                              {tr.regexMissed && tr.missingKeywords?.length > 0 ? '；' : ''}
                              {tr.missingKeywords?.length > 0
                                ? `缺少关键词（需全部出现）：${tr.missingKeywords.join('、')}`
                                : '请展开命中条件检查关键词/正则'}
                            </span>
                          )
                        )}
                      </div>
                    </>
                  ),
                }]}
              />
            </div>
          )
        })}
      </Drawer>
    </div>
  )
}
