// frontend/src/views/contract/ArchiveDrawer.jsx
// 文档归档抽屉：按时间倒序展示「原始合同 → 审查意见书 → 修订稿 V1/V2…」版本链，
// 每个版本可下载归档原件；修订稿/意见书可另存 PDF（服务端 Edge 无头打印）。
import { useEffect, useState } from 'react'
import { App, Button, Drawer, Dropdown, Empty, Spin, Tag, Timeline } from 'antd'
import {
  DownloadOutlined, FilePdfOutlined, HistoryOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { useContractStore } from '@/stores/contract.js'

const KIND_META = {
  ORIGINAL: { label: '原始合同', color: 'blue' },
  OPINION:  { label: '审查意见书', color: 'green' },
  REVISED:  { label: '修订稿', color: 'orange' },
}

function formatSize(bytes) {
  if (!bytes) return ''
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export default function ArchiveDrawer({ open, onClose, contractId, contractTitle, reviewTaskId }) {
  const { message } = App.useApp()
  const { loadVersions, downloadVersion, exportRevisionPdf, exportReportPdf } = useContractStore()
  const [versions, setVersions] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState('')   // 正在下载/导出的版本 id

  const refresh = async () => {
    if (!contractId) return
    setLoading(true)
    try {
      const data = await loadVersions(contractId)
      setVersions(data.versions || [])
    } catch (e) {
      message.error(e?.message || '归档记录加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (open) refresh()
  }, [open, contractId]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key, fn) => {
    setBusy(key)
    try {
      await fn()
    } catch (e) {
      message.warning(e?.status === 403
        ? (e.message || '当前套餐不支持导出，请升级套餐')
        : (e?.message || '操作失败，请稍后重试'))
    } finally {
      setBusy('')
    }
  }

  // 修订稿版本号：按时间升序给 V1/V2 编号
  const revisedOrder = [...versions]
    .filter((v) => v.kind === 'REVISED')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .map((v) => v.id)
  const versionNo = (id) => revisedOrder.indexOf(id) + 1

  const items = versions.map((v) => {
    const meta = KIND_META[v.kind] || { label: v.kind, color: 'default' }
    const isRevised = v.kind === 'REVISED'
    const label = isRevised ? `${meta.label} V${versionNo(v.id)}` : meta.label
    return {
      color: meta.color,
      children: (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{label}</Tag>
              <span style={{ fontSize: 12, color: '#6b7280' }}>
                {new Date(v.createdAt).toLocaleString('zh-CN', { hour12: false })}
              </span>
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              {v.fileName}
              {formatSize(v.sizeBytes) && ` · ${formatSize(v.sizeBytes)}`}
              {isRevised && v.appliedCount != null && ` · 应用 ${v.appliedCount} 处修订`}
              {isRevised && v.unmatchedCount > 0 && ` · ${v.unmatchedCount} 处进入附加建议`}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <Button
              size="small" icon={<DownloadOutlined />}
              loading={busy === `dl:${v.id}`}
              onClick={() => run(`dl:${v.id}`, () => downloadVersion(contractId, v.id, v.fileName))}
            >
              下载
            </Button>
            {isRevised && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'redline', label: '红划线版 PDF（保留修订痕迹）' },
                    { key: 'clean', label: '干净终版 PDF（仅修订后正文）' },
                  ],
                  onClick: ({ key }) => run(`pdf:${v.id}`, () => exportRevisionPdf(contractId, key)),
                }}
              >
                <Button size="small" icon={<FilePdfOutlined />} loading={busy === `pdf:${v.id}`}>
                  导出 PDF
                </Button>
              </Dropdown>
            )}
            {v.kind === 'OPINION' && reviewTaskId && (
              <Button
                size="small" icon={<FilePdfOutlined />}
                loading={busy === `pdf:${v.id}`}
                onClick={() => run(`pdf:${v.id}`, () => exportReportPdf(reviewTaskId))}
              >
                导出 PDF
              </Button>
            )}
          </div>
        </div>
      ),
    }
  })

  return (
    <Drawer
      title={<span><HistoryOutlined style={{ marginInlineEnd: 6 }} />文档归档 · {contractTitle || '合同'}</span>}
      width={620}
      open={open}
      onClose={onClose}
      extra={<Button size="small" icon={<ReloadOutlined />} onClick={refresh} loading={loading}>刷新</Button>}
    >
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
        原始合同、审查意见书与每次导出的修订稿都会归档留存，按时间倒序展示，可随时下载或另存为 PDF。
      </div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}><Spin /></div>
      ) : items.length ? (
        <Timeline items={items} />
      ) : (
        <Empty description="暂无归档记录" />
      )}
    </Drawer>
  )
}
