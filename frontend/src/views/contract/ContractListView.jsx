// frontend/src/views/contract/ContractListView.jsx
// 合同风险审查 · 合同列表：上传（文件/粘贴文本）、状态筛选、进入审查工作台
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Table, Tag, Modal, Tabs, Upload, Input, Form, Segmented, Popconfirm, Typography, App,
} from 'antd'
import {
  UploadOutlined, FileTextOutlined, DeleteOutlined, AuditOutlined, ReloadOutlined,
  ExperimentOutlined,
} from '@ant-design/icons'
import { useContractStore } from '@/stores/contract.js'
import styles from './ContractListView.module.css'

const { TextArea } = Input
const { Text } = Typography

// 列表筛选项 → 后端 reviewStatus 参数
const FILTERS = [
  { label: '全部', value: '' },
  { label: '待审查', value: 'PENDING' },
  { label: '待审批', value: 'WAITING_REVIEW' },
  { label: '已通过', value: 'APPROVED' },
  { label: '失败', value: 'FAILED' },
]

const SCENE_TEXT = {
  LABOR: '劳动合同', LEASE: '租赁合同', SERVICE: '劳务合同', NDA: '保密协议', CUSTOM: '非标合同',
}

// 审查状态（合同/任务整体阶段）
const REVIEW_PHASE_TAG = {
  WAITING_REVIEW: { color: 'blue', text: '待终审', dot: true },
  RUNNING: { color: 'processing', text: '审查中' },
  APPROVED: { color: 'default', text: '已完成' },
  REJECTED: { color: 'default', text: '已完成' },
}

// 审批状态（终审结论）
const APPROVAL_TAG = {
  WAITING_REVIEW: { color: 'orange', text: '待法务审' },
  APPROVED: { color: 'success', text: '已通过' },
  REJECTED: { color: 'error', text: '已驳回' },
}

export default function ContractListView() {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const {
    contracts, loadingList, loadContracts, uploadFile, uploadText, deleteContract,
    sampleCopied, copySample,
  } = useContractStore()
  const [filter, setFilter] = useState('')
  const [uploadOpen, setUploadOpen] = useState(false)
  const [tab, setTab] = useState('file')
  const [file, setFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [sampleLoading, setSampleLoading] = useState(false)
  const [form] = Form.useForm()

  useEffect(() => { loadContracts(filter) }, [loadContracts, filter])

  // 存在解析中/审查中的合同时自动轮询刷新
  const hasPending = useMemo(
    () => contracts.some((c) => ['PARSING', 'UPLOADED', 'REVIEWING'].includes(c.status)),
    [contracts],
  )
  useEffect(() => {
    if (!hasPending) return
    const timer = setInterval(() => loadContracts(filter), 4000)
    return () => clearInterval(timer)
  }, [hasPending, filter, loadContracts])

  const handleFileOk = async () => {
    if (!file) { message.warning('请先选择合同文件'); return }
    const title = form.getFieldValue('title')
    setSubmitting(true)
    try {
      const c = await uploadFile(file, title)
      setUploadOpen(false); setFile(null); form.resetFields()
      navigate(`/contracts/${c.id}`)
    } finally { setSubmitting(false) }
  }

  const handleTextOk = async () => {
    try {
      const v = await form.validateFields(['textTitle', 'content'])
      setSubmitting(true)
      const c = await uploadText({ title: v.textTitle, content: v.content })
      setUploadOpen(false); form.resetFields()
      navigate(`/contracts/${c.id}`)
    } finally { setSubmitting(false) }
  }

  // 空状态：体验示例合同（每租户限一次、不扣额度；FR-3）
  const handleCopySample = async () => {
    setSampleLoading(true)
    try {
      const c = await copySample()
      navigate(`/contracts/${c.id}`)
    } catch {
      // 409 等错误已由拦截器提示
    } finally {
      setSampleLoading(false)
    }
  }

  // 空列表：全部视图给双等权动作；筛选视图仅提示无数据
  const emptyNode = filter
    ? undefined
    : (
      <div className={styles.emptyState}>
        <div className={styles.emptyTitle}>还没有合同，先审一份看看</div>
        <div className={styles.emptySub}>免费版每月 2 份 · 3000 字以内 · 劳动 / 租赁 / 劳务 / NDA 四类</div>
        <div className={styles.emptyActions}>
          <Button
            type="primary" size="large" icon={<UploadOutlined />}
            onClick={() => { setUploadOpen(true); setTab('file') }}
          >
            上传我的合同
          </Button>
          {!sampleCopied && (
            <Button
              size="large" icon={<ExperimentOutlined />} loading={sampleLoading}
              onClick={handleCopySample}
            >
              体验示例合同
            </Button>
          )}
        </div>
      </div>
    )

  const columns = [
    {
      title: '合同',
      dataIndex: 'title',
      key: 'title',
      render: (t, row) => (
        <div>
          <div>
            <FileTextOutlined style={{ marginRight: 8, color: 'var(--color-primary)' }} />
            <a onClick={() => navigate(`/contracts/${row.id}`)}>{t}</a>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {SCENE_TEXT[row.scene] || '合同'} · {row.charCount} 字
            {row.playbookHitCount > 0 && (
              <Tag color="purple" style={{ marginLeft: 8, fontSize: 12, lineHeight: '18px', padding: '0 6px' }}>
                红线 {row.playbookHitCount}
              </Tag>
            )}
          </div>
        </div>
      ),
    },
    {
      title: '审查状态',
      key: 'reviewPhase',
      width: 110,
      render: (_, row) => {
        if (row.status === 'FAILED') return <Tag color="error">解析失败</Tag>
        const rs = row.review?.status
        if (!rs) return <Tag>待审查</Tag>
        const m = REVIEW_PHASE_TAG[rs]
        if (!m) return <Text type="secondary">—</Text>
        return <Tag color={m.color} dot={m.dot}>{m.text}</Tag>
      },
    },
    {
      title: '审批状态',
      key: 'approval',
      width: 110,
      render: (_, row) => {
        if (row.status === 'FAILED') return <Text type="secondary">—</Text>
        const m = APPROVAL_TAG[row.review?.status]
        return m ? <Tag color={m.color}>{m.text}</Tag> : <Text type="secondary">—</Text>
      },
    },
    {
      title: '条款数',
      dataIndex: 'clausesCount',
      key: 'clausesCount',
      width: 80,
      render: (n) => n ?? 0,
    },
    {
      title: '最近审查',
      key: 'reviewedAt',
      width: 150,
      render: (_, row) => row.review
        ? new Date(row.review.createdAt).toLocaleDateString('zh-CN')
        : <Text type="secondary">—</Text>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_, row) => {
        const rs = row.review?.status
        let actionText = '审查工作台'
        if (row.status === 'FAILED') actionText = '重新上传'
        else if (rs === 'APPROVED' && row.hasReport) actionText = '查看意见书'
        else if (!rs) actionText = '开始审查'
        return (
          <div className={styles.rowActions} onClick={(e) => e.stopPropagation()}>
            <Button
              type="link" size="small" icon={<AuditOutlined />}
              disabled={row.status === 'UPLOADED' || row.status === 'PARSING'}
              onClick={() => navigate(`/contracts/${row.id}`)}
            >
              {actionText}
            </Button>
            <Popconfirm
              title="确认删除该合同？条款、审查记录与风险将一并删除"
              onConfirm={() => deleteContract(row.id)}
              okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
            >
              <Button type="link" size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        )
      },
    },
  ]

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <div>
          <div className={styles.title}>合同风险审查</div>
          <div className={styles.subtitle}>规则引擎保底 + AI 语义审查双轨，人工终审后生成审查意见书</div>
        </div>
        <div className={styles.toolbarRight}>
          <Segmented
            options={FILTERS.map((f) => ({ label: f.label, value: f.value }))}
            value={filter}
            onChange={(v) => setFilter(v)}
          />
          <Button icon={<ReloadOutlined />} onClick={() => loadContracts(filter)} loading={loadingList}>刷新</Button>
          <Button type="primary" icon={<UploadOutlined />} onClick={() => { setUploadOpen(true); setTab('file') }}>
            上传合同
          </Button>
        </div>
      </div>

      <div className={styles.card}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={contracts}
          loading={loadingList}
          scroll={{ x: 900 }}
          locale={{ emptyText: emptyNode || '暂无数据' }}
          pagination={{ pageSize: 15, hideOnSinglePage: true }}
          onRow={(row) => ({ onClick: () => navigate(`/contracts/${row.id}`), style: { cursor: 'pointer' } })}
        />
      </div>

      <Modal
        title="上传合同"
        open={uploadOpen}
        width={620}
        onCancel={() => setUploadOpen(false)}
        confirmLoading={submitting}
        okText={tab === 'file' ? '上传并解析' : '创建并解析'}
        onOk={tab === 'file' ? handleFileOk : handleTextOk}
        destroyOnClose
      >
        <Tabs activeKey={tab} onChange={setTab} items={[
          {
            key: 'file',
            label: '文件上传',
            children: (
              <Form form={form} layout="vertical">
                <Form.Item name="title" label="合同标题（可选，默认用文件名）">
                  <Input placeholder="例如：2026 年度 SaaS 服务合同" />
                </Form.Item>
                <Upload.Dragger
                  accept=".txt,.md,.pdf,.docx,.jpg,.jpeg,.png"
                  maxCount={1}
                  beforeUpload={(f) => { setFile(f); return false }}
                  onRemove={() => setFile(null)}
                >
                  <p className="ant-upload-drag-icon"><UploadOutlined /></p>
                  <p className="ant-upload-text">点击选择或拖拽合同文件到此</p>
                  <p className="ant-upload-hint">
                    支持 .txt / .md / .pdf / .docx；也支持 .jpg / .png 合同照片（AI 视觉 OCR 自动识别）
                    {/\.(jpe?g|png)$/i.test(file?.name || '') && ' · 图片识别约需 10~60 秒，请耐心等待解析完成'}
                  </p>
                </Upload.Dragger>
              </Form>
            ),
          },
          {
            key: 'text',
            label: '粘贴文本',
            children: (
              <Form form={form} layout="vertical">
                <Form.Item name="textTitle" label="合同标题"><Input placeholder="例如：员工劳动合同（赵某）" /></Form.Item>
                <Form.Item name="content" label="合同正文" rules={[{ required: true, message: '合同内容不能为空' }]}>
                  <TextArea rows={10} placeholder="粘贴合同全文，条款请使用「第一条 / 第二条 …」格式以便自动切分" />
                </Form.Item>
              </Form>
            ),
          },
        ]} />
      </Modal>
    </div>
  )
}
