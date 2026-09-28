// frontend/src/views/team/LedgerView.jsx
// 合同台账（FR-16，文案对齐 docs/prototype/ledger.html）：
// 统计卡 / 分桶筛选 / 搜索 / 新增·编辑·续签·解除 / 从审查记录 AI 预填（无 Key 黄条手填）。
// 个人空间共用同一领域（额度 ≤10），企业空间不限条数。
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, DatePicker, Drawer, Empty, Form, Input, Modal, Popconfirm, Select, Spin, Table, Tag,
} from 'antd'
import { PlusOutlined, FileSearchOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { useMeStore } from '@/stores/me.js'
import { useLedgerStore } from '@/stores/ledger.js'
import http from '@/utils/http.js'
import shared from '../personal/personal.module.css'
import css from './ledger.module.css'

const { TextArea } = Input

const TYPE_OPTIONS = [
  { value: 'FIXED_TERM_LABOR', label: '固定期限劳动合同' },
  { value: 'OPEN_ENDED_LABOR', label: '无固定期限劳动合同' },
  { value: 'SERVICE', label: '劳务协议' },
  { value: 'INTERNSHIP', label: '实习协议' },
  { value: 'NDA', label: '保密协议' },
  { value: 'NON_COMPETE', label: '竞业限制协议' },
  { value: 'OTHER', label: '其他' },
]
const TYPE_LABEL = Object.fromEntries(TYPE_OPTIONS.map((o) => [o.value, o.label]))
const REMIND_OPTIONS = [7, 30, 60, 90]

const FILTERS = [
  { key: 'ALL', label: '全部' },
  { key: 'ACTIVE', label: '履行中' },
  { key: 'DUE_30', label: '30 天内到期' },
  { key: 'EXPIRED', label: '已过期' },
  { key: 'RENEWED', label: '已续签' },
]

const REVIEW_STATUS_LABEL = {
  RUNNING: '审查中',
  WAITING_REVIEW: '待法务审',
  APPROVED: '审查通过',
  REJECTED: '审查驳回',
}

function ExpiryTag({ item }) {
  if (item.status === 'ACTIVE') {
    if (item.bucket === 'EXPIRED') {
      return <span className={`${shared.tag} ${shared.tagRed}`}>已过期 {-daysTo(item.endDate)} 天</span>
    }
    if (item.bucket === 'DUE_30') {
      return <span className={`${shared.tag} ${shared.tagOrange}`}>{daysTo(item.endDate)} 天后到期</span>
    }
    if (item.bucket === 'DUE_90') {
      return <span className={css.tagYellow}>{daysTo(item.endDate)} 天后到期</span>
    }
    if (item.bucket === 'LONG_TERM') {
      return <span className={`${shared.tag} ${shared.tagGray}`}>长期履行</span>
    }
    if (item.probationDays !== null && item.probationDays >= 0) {
      return (
        <span className={`${shared.tag} ${shared.tagGray}`}>
          试用期 {item.probationEnd.slice(5).replace('-', '-')} 到期
        </span>
      )
    }
    return <span className={`${shared.small} ${shared.muted}`}>正常履行</span>
  }
  if (item.status === 'RENEWED') {
    return <span className={`${shared.small} ${shared.muted}`}>已续签新合同</span>
  }
  return <span className={`${shared.small} ${shared.muted}`}>已协商解除</span>
}

function daysTo(dateStr) {
  return Math.floor((dayjs(dateStr).startOf('day').valueOf() - dayjs().startOf('day').valueOf()) / 86400000)
}

export default function LedgerView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const {
    items, total, stats, loading, query, setQuery, loadList,
    create, update, renew, terminate, remove, extract,
  } = useLedgerStore()

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [mode, setMode] = useState('create') // create | edit | renew
  const [baseRecord, setBaseRecord] = useState(null) // 续签/编辑的原记录
  const [aiBanner, setAiBanner] = useState(null) // {type:'ai'|'manual', title}
  const [linkedContract, setLinkedContract] = useState(null) // {id,title}
  const [saving, setSaving] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [contractChoices, setContractChoices] = useState([])
  const [picking, setPicking] = useState(false)
  const [extracting, setExtracting] = useState(false)
  const [form] = Form.useForm()
  const contractType = Form.useWatch('contractType', form)
  const remindBeforeDays = Form.useWatch('remindBeforeDays', form)
  const isPersonal = entitlement?.workspaceType === 'PERSONAL'

  useEffect(() => { loadEntitlement() }, [loadEntitlement])
  useEffect(() => { loadList() }, []) // 首次加载；筛选走 store.setQuery

  const openBlank = () => {
    setMode('create')
    setBaseRecord(null)
    setAiBanner(null)
    setLinkedContract(null)
    form.resetFields()
    form.setFieldsValue({ contractType: 'FIXED_TERM_LABOR', remindBeforeDays: 30 })
    setDrawerOpen(true)
  }

  const openEdit = (record) => {
    setMode('edit')
    setBaseRecord(record)
    setAiBanner(null)
    setLinkedContract(record.linkedContract ? { id: record.linkedContract.id, title: record.linkedContract.title } : null)
    form.setFieldsValue(toFormValues(record))
    setDrawerOpen(true)
  }

  const openRenew = (record) => {
    setMode('renew')
    setBaseRecord(record)
    setAiBanner(null)
    setLinkedContract(record.linkedContract ? { id: record.linkedContract.id, title: record.linkedContract.title } : null)
    form.resetFields()
    form.setFieldsValue({
      employeeName: record.employeeName,
      dept: record.dept || undefined,
      contractType: record.contractType,
      position: record.position || undefined,
      remindBeforeDays: record.remindBeforeDays,
      linkedContractId: record.linkedContractId || undefined,
      note: record.note || undefined,
    })
    setDrawerOpen(true)
  }

  const openPicker = async () => {
    setPickerOpen(true)
    if (!contractChoices.length) {
      setPicking(true)
      try {
        const res = await http.get('/contracts', { params: { pageSize: 100 } })
        setContractChoices(res.contracts || [])
      } finally {
        setPicking(false)
      }
    }
  }

  /** 选择审查合同：AI 抽取预填；409（无 Key）黄条手填，关联关系仍保留 */
  const pickContract = async (contractId) => {
    const contract = contractChoices.find((c) => c.id === contractId)
    if (!contract) return
    setExtracting(true)
    try {
      const res = await extract(contractId)
      form.resetFields()
      form.setFieldsValue({
        ...fieldsToForm(res.fields),
        linkedContractId: contractId,
      })
      setMode('create')
      setBaseRecord(null)
      setLinkedContract({ id: contractId, title: contract.title, reviewedAt: res.contract.reviewedAt, reviewStatus: res.contract.reviewStatus })
      setAiBanner({ type: 'ai', title: contract.title })
    } catch (e) {
      const code = e?.response?.data?.error?.code
      if (code === 'AI_UNAVAILABLE' || e?.response?.status === 409) {
        form.resetFields()
        form.setFieldsValue({ contractType: 'FIXED_TERM_LABOR', remindBeforeDays: 30, linkedContractId: contractId })
        setMode('create')
        setBaseRecord(null)
        setLinkedContract({ id: contractId, title: contract.title })
        setAiBanner({ type: 'manual', title: contract.title })
      } else {
        return // http 拦截器已 toast
      }
    } finally {
      setExtracting(false)
      setPickerOpen(false)
      setDrawerOpen(true)
    }
  }

  const handleSave = async () => {
    const values = await form.validateFields()
    const payload = {
      employeeName: values.employeeName,
      dept: values.dept || null,
      contractType: values.contractType,
      position: values.position || null,
      startDate: values.startDate.format('YYYY-MM-DD'),
      endDate: values.contractType === 'OPEN_ENDED_LABOR' ? null : (values.endDate ? values.endDate.format('YYYY-MM-DD') : null),
      probationEnd: values.probationEnd ? values.probationEnd.format('YYYY-MM-DD') : null,
      remindBeforeDays: values.remindBeforeDays,
      linkedContractId: values.linkedContractId || null,
      note: values.note || null,
    }
    setSaving(true)
    try {
      if (mode === 'edit') {
        await update(baseRecord.id, payload)
      } else if (mode === 'renew') {
        await renew(baseRecord.id, payload)
      } else {
        await create(payload)
      }
      setDrawerOpen(false)
      await loadList()
    } catch (e) {
      const code = e?.response?.data?.error?.code
      if (code === 'PLAN_LIMIT') {
        Modal.confirm({
          title: '台账条数已达套餐上限',
          icon: <ExclamationCircleOutlined />,
          content: e?.response?.data?.error?.message || '免费 / 个人版台账最多 10 条，团队版不限条数',
          okText: '了解团队版 TEAM',
          cancelText: '取消',
          onOk: () => navigate('/pricing'),
        })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleTerminate = async () => {
    await terminate(baseRecord.id)
    setDrawerOpen(false)
    await loadList()
  }

  const handleDelete = async (id) => {
    await remove(id)
    await loadList()
  }

  const columns = useMemo(() => [
    {
      title: '员工',
      dataIndex: 'employeeName',
      render: (_, r) => (
        <div>
          <b>{r.employeeName}</b>
          <div className={shared.cellSub}>{[r.dept, r.position].filter(Boolean).join(' · ') || '—'}</div>
        </div>
      ),
    },
    { title: '合同类型', dataIndex: 'contractTypeLabel', width: 160 },
    {
      title: '合同期限',
      width: 180,
      render: (_, r) => (
        <div className={shared.small}>
          {r.startDate}
          <br />
          {r.endDate ? `~ ${r.endDate}` : '起 · 无固定到期日'}
        </div>
      ),
    },
    { title: '到期状态', width: 160, render: (_, r) => <ExpiryTag item={r} /> },
    {
      title: '状态',
      width: 150,
      render: (_, r) => {
        if (r.status === 'ACTIVE') {
          const expired = r.bucket === 'EXPIRED'
          return <span className={`${shared.tag} ${expired ? shared.tagRed : shared.tagGreen}`}>履行中</span>
        }
        if (r.status === 'RENEWED') {
          return (
            <div>
              <span className={`${shared.tag} ${shared.tagGray}`}>已续签</span>
            </div>
          )
        }
        return <span className={`${shared.tag} ${shared.tagGray}`}>已解除</span>
      },
    },
    {
      title: '操作',
      width: 210,
      render: (_, r) => (
        <div className={css.rowActions}>
          {r.status === 'ACTIVE' && r.bucket === 'EXPIRED' && (
            <Button type="link" size="small" danger onClick={() => openRenew(r)}>立即续签</Button>
          )}
          {r.status === 'ACTIVE' && r.bucket !== 'EXPIRED' && (
            <Button type="link" size="small" onClick={() => openRenew(r)}>续签</Button>
          )}
          {r.status === 'RENEWED' && r.renewal && (
            <Button type="link" size="small" onClick={() => {
              const fresh = useLedgerStore.getState().items.find((x) => x.id === r.renewal.id)
              if (fresh) openEdit(fresh)
              else navigate(`/ledger`)
            }}>查看新合同</Button>
          )}
          {r.linkedContractId && r.status === 'ACTIVE' && (
            <Button type="link" size="small" onClick={() => navigate(`/contracts/${r.linkedContractId}`)}>查看审查</Button>
          )}
          {r.status !== 'RENEWED' && <Button type="link" size="small" onClick={() => openEdit(r)}>编辑</Button>}
          <Popconfirm title="删除该台账记录？" okText="删除" okButtonProps={{ danger: true }} cancelText="取消" onConfirm={() => handleDelete(r.id)}>
            <Button type="link" size="small" danger>删除</Button>
          </Popconfirm>
        </div>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [items])

  const monthDelta = stats ? stats.thisMonthSigned - stats.lastMonthSigned : 0

  return (
    <div className={css.page}>
      <div className={css.statGrid}>
        <div className={css.statCard}>
          <div className={css.scTop}>履行中</div>
          <div className={css.scNum}>{stats?.active ?? 0}</div>
          <div className={css.scFoot}>含无固定期限 {stats?.openEnded ?? 0} 份</div>
        </div>
        <div className={css.statCard}>
          <div className={css.scTop}>30 天内到期</div>
          <div className={`${css.scNum} ${css.scWarning}`}>{stats?.due30 ?? 0}</div>
          <div className={css.scFoot}>建议尽快发起续签流程</div>
        </div>
        <div className={css.statCard}>
          <div className={css.scTop}>已过期未处理</div>
          <div className={`${css.scNum} ${css.scDanger}`}>{stats?.expired ?? 0}</div>
          <div className={css.scFoot}>超期未续签，存在用工风险</div>
        </div>
        <div className={css.statCard}>
          <div className={css.scTop}>本月新签 / 续签</div>
          <div className={css.scNum}>{stats?.thisMonthSigned ?? 0}</div>
          <div className={css.scFoot}>
            较上月{monthDelta > 0 ? ` +${monthDelta}` : monthDelta < 0 ? ` ${monthDelta}` : ' 持平'}
          </div>
        </div>
      </div>

      <div className={css.toolbar}>
        <div className={css.segWrap}>
          <div className={css.seg}>
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`${css.segItem} ${query.filter === f.key ? css.segOn : ''}`}
                onClick={() => setQuery({ filter: f.key, page: 1 })}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Input.Search
            allowClear
            placeholder="搜索员工姓名 / 部门"
            style={{ width: 220 }}
            onSearch={(v) => setQuery({ q: v, page: 1 })}
          />
        </div>
        <div className={css.toolBtns}>
          {isPersonal && <span className={`${shared.small} ${shared.muted}`}>免费 / 个人版台账最多 10 条 · 当前 {total} 条</span>}
          <Button icon={<FileSearchOutlined />} onClick={openPicker}>从审查记录加入</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openBlank}>新增台账记录</Button>
        </div>
      </div>

      <div className={shared.panel}>
        <Spin spinning={loading}>
          <Table
            rowKey="id"
            columns={columns}
            dataSource={items}
            scroll={{ x: 1000 }}
            pagination={{
              current: query.page,
              pageSize: query.pageSize,
              total,
              showSizeChanger: false,
              showTotal: (t) => `共 ${t} 条`,
              onChange: (page) => setQuery({ page }),
            }}
            locale={{ emptyText: <Empty description="暂无台账记录，点击右上角「新增台账记录」" /> }}
          />
        </Spin>
      </div>

      {/* 从审查记录加入 */}
      <Modal
        title="从审查记录加入台账"
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        footer={null}
        transitionName=""
        maskTransitionName=""
      >
        <Spin spinning={picking || extracting} tip={extracting ? 'AI 正在识别合同信息…' : ''}>
          <p className={`${shared.small} ${shared.muted}`}>选择一份已审查的合同，AI 将自动识别员工、期限、试用期等字段。</p>
          <Select
            showSearch
            autoFocus
            style={{ width: '100%' }}
            placeholder="选择审查过的合同"
            options={contractChoices.map((c) => ({
              value: c.id,
              label: `${c.title}（${dayjs(c.createdAt).format('YYYY-MM-DD')}）`,
            }))}
            filterOption={(input, option) => (option?.label ?? '').toLowerCase().includes(input.toLowerCase())}
            onChange={pickContract}
            loading={picking}
          />
        </Spin>
      </Modal>

      {/* 新增 / 编辑 / 续签 抽屉 */}
      <Drawer
        width={720}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={mode === 'edit' ? '编辑合同台账记录' : mode === 'renew' ? '续签合同' : '新增合同台账记录'}
        transitionName=""
        maskTransitionName=""
        destroyOnClose
        extra={mode === 'renew' && <Tag color="orange">原合同将标记为「已续签」</Tag>}
        footer={(
          <div className={css.drawerFoot}>
            <div>
              {mode === 'edit' && baseRecord?.status === 'ACTIVE' && (
                <Popconfirm
                  title="确认协商解除该合同？"
                  description="解除后记录保留在台账，状态变为「已解除」"
                  okText="确认解除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={handleTerminate}
                >
                  <Button danger>协商解除合同</Button>
                </Popconfirm>
              )}
            </div>
            <div className={css.footRight}>
              <Button onClick={() => setDrawerOpen(false)}>取消</Button>
              <Button type="primary" loading={saving} onClick={handleSave}>
                {mode === 'renew' ? '确认续签' : '核对无误，保存记录'}
              </Button>
            </div>
          </div>
        )}
      >
        {aiBanner?.type === 'ai' && (
          <div className={shared.bannerWarn}>
            <ExclamationCircleOutlined style={{ marginRight: 8, flex: 'none' }} />
            <div>
              以下信息由 AI 从《{aiBanner.title}》自动识别带入，识别结果可能不准确，
              <b>请逐项核对并补全后再保存</b>。未识别字段已留空。
            </div>
          </div>
        )}
        {aiBanner?.type === 'manual' && (
          <div className={shared.bannerWarn}>
            <ExclamationCircleOutlined style={{ marginRight: 8, flex: 'none' }} />
            <div>未配置模型 Key，无法从《{aiBanner.title}》自动识别，请<b>手动填写</b>台账信息，关联的审查合同会自动保留。</div>
          </div>
        )}

        <Form form={form} layout="vertical" className={css.formGrid} initialValues={{ contractType: 'FIXED_TERM_LABOR', remindBeforeDays: 30 }}>
          <Form.Item name="employeeName" label="员工姓名" rules={[{ required: true, message: '请输入员工姓名' }]}>
            <Input maxLength={100} placeholder="如：钱某" />
          </Form.Item>
          <Form.Item name="dept" label="所属部门">
            <Input maxLength={100} placeholder="如：研发部" />
          </Form.Item>
          <Form.Item name="contractType" label="合同类型" rules={[{ required: true }]}>
            <Select options={TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="position" label="担任岗位">
            <Input maxLength={100} placeholder="如：前端工程师" />
          </Form.Item>
          <Form.Item name="startDate" label="开始日期" rules={[{ required: true, message: '请选择开始日期' }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="endDate"
            label="到期日期"
            rules={[{
              validator: (_, v) => {
                if (!v || contractType === 'OPEN_ENDED_LABOR') return Promise.resolve()
                const start = form.getFieldValue('startDate')
                if (start && v.isBefore(start, 'day')) return Promise.reject(new Error('到期日期不能早于开始日期'))
                return Promise.resolve()
              },
            }]}
            extra={contractType === 'OPEN_ENDED_LABOR' ? '无固定期限合同无需填写到期日期' : undefined}
          >
            <DatePicker style={{ width: '100%' }} disabled={contractType === 'OPEN_ENDED_LABOR'} />
          </Form.Item>
          <Form.Item
            name="probationEnd"
            label="试用期到期"
            rules={[{
              validator: (_, v) => {
                if (!v) return Promise.resolve()
                const start = form.getFieldValue('startDate')
                if (start && v.isBefore(start, 'day')) return Promise.reject(new Error('试用期到期不能早于开始日期'))
                const end = form.getFieldValue('endDate')
                if (contractType !== 'OPEN_ENDED_LABOR' && end && v.isAfter(end, 'day')) {
                  return Promise.reject(new Error('试用期到期不能晚于合同到期日期'))
                }
                return Promise.resolve()
              },
            }]}
            extra="无试用期则留空"
          >
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="remindBeforeDays" label="提前提醒">
            <div className={css.seg}>
              {REMIND_OPTIONS.map((d) => (
                <button
                  type="button"
                  key={d}
                  className={`${css.segItem} ${remindBeforeDays === d ? css.segOn : ''}`}
                  onClick={() => form.setFieldValue('remindBeforeDays', d)}
                >
                  {d} 天
                </button>
              ))}
            </div>
          </Form.Item>
          <Form.Item name="linkedContractId" hidden><Input /></Form.Item>
          <Form.Item label="关联审查合同" className={css.colspan2}>
            <Input
              readOnly
              value={linkedContract ? linkedDisplay(linkedContract) : ''}
              placeholder="可通过左上角「从审查记录加入」自动带入"
              style={{ background: 'var(--color-border-light)', color: 'var(--color-text-sub)' }}
            />
          </Form.Item>
          <Form.Item name="note" label="备注" className={css.colspan2}>
            <TextArea rows={3} maxLength={2000} placeholder="如：续签意向已与员工沟通，预计 9 月 25 日前签署新合同" />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  )
}

/** 关联合同只读文案：《title》（YYYY-MM-DD 审查，状态）；编辑态信息不全时显示「title（已关联审查记录）」 */
function linkedDisplay(lc) {
  if (lc.reviewedAt) {
    const status = REVIEW_STATUS_LABEL[lc.reviewStatus] ? `，${REVIEW_STATUS_LABEL[lc.reviewStatus]}` : ''
    return `${lc.title}（${dayjs(lc.reviewedAt).format('YYYY-MM-DD')} 审查${status}）`
  }
  return `${lc.title}（已关联审查记录）`
}

function toFormValues(r) {
  return {
    employeeName: r.employeeName,
    dept: r.dept || undefined,
    contractType: r.contractType,
    position: r.position || undefined,
    startDate: r.startDate ? dayjs(r.startDate) : undefined,
    endDate: r.endDate ? dayjs(r.endDate) : undefined,
    probationEnd: r.probationEnd ? dayjs(r.probationEnd) : undefined,
    remindBeforeDays: r.remindBeforeDays,
    linkedContractId: r.linkedContractId || undefined,
    note: r.note || undefined,
  }
}

function fieldsToForm(f) {
  return {
    employeeName: f.employeeName || undefined,
    dept: f.dept || undefined,
    contractType: f.contractType || 'FIXED_TERM_LABOR',
    position: f.position || undefined,
    startDate: f.startDate ? dayjs(f.startDate) : undefined,
    endDate: f.endDate ? dayjs(f.endDate) : undefined,
    probationEnd: f.probationEnd ? dayjs(f.probationEnd) : undefined,
    remindBeforeDays: f.remindBeforeDays || 30,
    note: f.note || undefined,
  }
}
