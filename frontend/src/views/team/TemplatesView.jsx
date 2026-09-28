// frontend/src/views/team/TemplatesView.jsx
// 合同范本库（对齐 docs/prototype/templates.html，FR-20）
// - 12 套高频文书：分类 + 搜索 + 卡片，在线预览全文
// - FREE 仅可在线预览；采用（生成 READY 文本合同）/ 下载 Word 为 PERSONAL+ 能力
// - 个人 / 企业共用页面，权限随套餐
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Button, Drawer, Empty, Input, Modal, Segmented, Spin, Tag, message,
} from 'antd'
import {
  BankOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  HomeOutlined,
  InfoCircleOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SolutionOutlined,
} from '@ant-design/icons'
import http from '@/utils/http.js'
import { useAuthStore } from '@/stores/auth.js'
import { useMeStore } from '@/stores/me.js'
import css from './templates.module.css'

const CATEGORIES = ['全部', '劳动合同类', '租赁类', '兼职与通用']

const CATEGORY_COLOR = {
  劳动合同类: 'blue',
  租赁类: 'orange',
  兼职与通用: 'purple',
}

const ICON_CLS = {
  劳动合同类: 'iconLabor',
  租赁类: 'iconLease',
  兼职与通用: 'iconGeneric',
}

function TemplateIcon({ docId, category }) {
  if (docId === 'tpl_house_lease') return <HomeOutlined />
  if (docId === 'tpl_office_lease') return <BankOutlined />
  if (docId === 'tpl_nda' || docId === 'tpl_confidentiality') return <SafetyCertificateOutlined />
  if (category === '兼职与通用') return <SolutionOutlined />
  if (docId === 'tpl_offer' || docId === 'tpl_renew_notice' || docId === 'tpl_termination_notice') {
    return <FileDoneOutlined />
  }
  return <FileTextOutlined />
}

const CLAUSE_LINE = /^第[一二三四五六七八九十两〇零\d]{1,5}条/

export default function TemplatesView() {
  const navigate = useNavigate()
  const { entitlement, loadEntitlement } = useMeStore()
  const workspaceType = entitlement?.workspaceType
  const accessToken = useAuthStore((s) => s.accessToken)

  const [loading, setLoading] = useState(true)
  const [templates, setTemplates] = useState([])
  const [canAdopt, setCanAdopt] = useState(false)
  const [category, setCategory] = useState('全部')
  const [kw, setKw] = useState('')

  const [previewItem, setPreviewItem] = useState(null)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [adoptingId, setAdoptingId] = useState(null)
  const [downloadingId, setDownloadingId] = useState(null)
  const [paywallItem, setPaywallItem] = useState(null)

  useEffect(() => { loadEntitlement() }, [loadEntitlement])

  const load = async () => {
    setLoading(true)
    try {
      const data = await http.get('/templates')
      setTemplates(data.templates || [])
      setCanAdopt(!!data.canAdopt)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase()
    return templates.filter((t) => {
      if (category !== '全部' && t.category !== category) return false
      if (!q) return true
      return t.title.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
    })
  }, [templates, category, kw])

  const openPreview = async (item) => {
    setPreviewItem(item)
    setPreview(null)
    setPreviewLoading(true)
    try {
      setPreview(await http.get(`/templates/${item.docId}/preview`))
    } finally {
      setPreviewLoading(false)
    }
  }

  const closePreview = () => {
    setPreviewItem(null)
    setPreview(null)
  }

  const gotoContracts = () => {
    navigate(workspaceType === 'TEAM' ? '/contracts' : '/my-contracts')
  }

  const adopt = async (item) => {
    if (!canAdopt) {
      setPaywallItem(item)
      return
    }
    setAdoptingId(item.docId)
    try {
      await http.post(`/templates/${item.docId}/adopt`, {}, { skipErrorToast: true })
      message.success('已采用范本，可编辑合同已生成')
      closePreview()
      gotoContracts()
    } catch (err) {
      if (err.response?.status === 403 && err.response?.data?.error?.code === 'PLAN_LIMIT') {
        setCanAdopt(false)
        setPaywallItem(item)
      } else {
        message.error(err.response?.data?.error?.message || '采用失败，请稍后重试')
      }
    } finally {
      setAdoptingId(null)
    }
  }

  const download = async (item) => {
    if (!canAdopt) {
      setPaywallItem(item)
      return
    }
    setDownloadingId(item.docId)
    try {
      const resp = await fetch(`/api/templates/${item.docId}/download`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}))
        if (resp.status === 403 && data.error?.code === 'PLAN_LIMIT') {
          setCanAdopt(false)
          setPaywallItem(item)
          return
        }
        throw new Error(data.error?.message || '下载失败')
      }
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = item.fileName.replace(/\.txt$/, '.docx')
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      message.error(err.message || '下载失败，请稍后重试')
    } finally {
      setDownloadingId(null)
    }
  }

  const renderPreviewLines = (text) => text.split('\n').map((line, i) => {
    const t = line.trim()
    if (!t) return <div key={i} className={css.previewBlank} />
    if (CLAUSE_LINE.test(t)) return <p key={i} className={css.previewClause}>{t}</p>
    return <p key={i} className={css.previewLine}>{t}</p>
  })

  return (
    <div className={css.page}>
      <div className={css.subHead}>12 套高频文书 · 劳动 / 租赁 / 兼职通用 · 在线预览 · 一键采用发起审查</div>

      <div className={css.toolbar}>
        <Segmented
          value={category}
          onChange={setCategory}
          options={CATEGORIES}
        />
        <Input
          className={css.search}
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜索范本名称 / 关键字"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
        />
      </div>

      {loading ? (
        <div className={css.center}><Spin size="large" tip="加载范本库…" /></div>
      ) : filtered.length === 0 ? (
        <Empty description="没有匹配的范本" className={css.center} />
      ) : (
        <div className={css.grid}>
          {filtered.map((item) => (
            <div
              key={item.docId}
              className={`${css.card} ${item.isNew ? css.cardNew : ''}`}
            >
              <div className={`${css.tplIcon} ${css[ICON_CLS[item.category]] || ''}`}>
                <TemplateIcon docId={item.docId} category={item.category} />
              </div>
              <div className={css.tags}>
                <Tag color={CATEGORY_COLOR[item.category]}>{item.category}</Tag>
                {item.isNew && <Tag color="blue">新</Tag>}
              </div>
              <b className={css.tplTitle}>{item.title}</b>
              <div className={css.tplDesc}>{item.summary}</div>
              <div className={css.actions}>
                <Button size="small" onClick={() => openPreview(item)}>预览</Button>
                <Button
                  type="primary"
                  size="small"
                  loading={adoptingId === item.docId}
                  onClick={() => adopt(item)}
                >
                  采用
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={css.tipBar}>
        <InfoCircleOutlined className={css.tipIcon} />
        <div>范本由平台依据现行法规整理，使用前请结合所在地规定与实际情况调整；免费仅可在线预览，「采用」后会在「合同审查」中生成一份可编辑的文本合同，可直接发起审查。</div>
      </div>

      {/* 范本预览抽屉 */}
      <Drawer
        open={!!previewItem}
        onClose={closePreview}
        width={560}
        title={null}
        styles={{ header: { display: 'none' } }}
        destroyOnClose
      >
        {previewItem && (
          <div className={css.drawerWrap}>
            <div className={css.drawerHead}>
              <div>
                <h3 className={css.drawerTitle}>{previewItem.title}</h3>
                <div className={css.drawerMeta}>
                  {previewItem.category}
                  {preview ? ` · 全文约 ${preview.chars.toLocaleString('zh-CN')} 字 · ${preview.clauses} 个条款` : ''}
                  {previewItem.updatedAt ? ` · 更新于 ${String(previewItem.updatedAt).slice(0, 7).replace('-', '-')}` : ''}
                </div>
              </div>
            </div>
            <div className={css.drawerBody}>
              {previewLoading || !preview ? (
                <div className={css.previewLoading}><Spin tip="加载全文…" /></div>
              ) : (
                <div className={css.docPreview}>{renderPreviewLines(preview.content)}</div>
              )}
            </div>
            <div className={css.drawerFoot}>
              <Button onClick={() => download(previewItem)} loading={downloadingId === previewItem.docId}>
                下载 Word
              </Button>
              {canAdopt ? (
                <Button type="primary" loading={adoptingId === previewItem.docId} onClick={() => adopt(previewItem)}>
                  采用此范本，去发起审查
                </Button>
              ) : (
                <>
                  <Button disabled icon={<LockOutlined />}>免费仅可在线预览</Button>
                  <Button type="primary" onClick={() => setPaywallItem(previewItem)}>
                    采用此范本，去发起审查
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* 采用 / 下载付费墙（文案对齐 templates.html） */}
      <Modal
        open={!!paywallItem}
        onCancel={() => setPaywallItem(null)}
        footer={null}
        width={440}
        centered
        transitionName=""
        maskTransitionName=""
      >
        <div className={css.paywall}>
          <div className={css.pwIcon}><FileTextOutlined /></div>
          <h3>免费仅可在线预览</h3>
          <p className={css.pwMuted}>采用范本生成可编辑合同、下载 Word 需要付费能力</p>
          <ul className={css.pwFeats}>
            <li><Tag color="purple" className={css.pwTag}>券</Tag><span><b>深度审查券 ¥9.9 / 份</b>，采用范本并立即审查这份合同</span></li>
            <li><Tag color="blue" className={css.pwTag}>个人版</Tag><span><b>¥19 / 月 · ¥99 / 年</b>，范本采用、Word 导出不限次</span></li>
            <li><Tag color="green" className={css.pwTag}>团队版</Tag><span>公司标准合同库 + Playbook 规则联动，<b>团队升级请联系顾问</b></span></li>
          </ul>
          <Button type="primary" size="large" block onClick={() => navigate('/checkout?item=COUPON_PACK')}>
            用券 ¥9.9 采用并审查
          </Button>
          <div className={css.pwRow}>
            <Button block onClick={() => navigate('/me/billing')}>个人版 ¥19/月</Button>
            <Button block onClick={() => navigate('/pricing')}>团队升级咨询</Button>
          </div>
          <div className={css.pwContinue}>
            <a onClick={() => setPaywallItem(null)}>继续在线预览</a>
          </div>
        </div>
      </Modal>
    </div>
  )
}
