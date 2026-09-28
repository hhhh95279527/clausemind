// frontend/src/components/layout/NotificationBell.jsx
// 站内通知铃铛（FR-22）：GET /api/notifications → { items, unread }
// 无落库、无已读态：点击铃铛即视为本次已读（本地状态），60s 轮询 + 窗口聚焦刷新
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge, Popover, List, Empty } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import http from '@/utils/http'

const LEVEL_COLOR = { danger: '#ff4d4f', warning: '#faad14', info: '#1677ff' }

export default function NotificationBell() {
  const navigate = useNavigate()
  const [items, setItems] = useState([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const readCount = useRef(0)

  const refresh = useCallback(async () => {
    try {
      const data = await http.get('/notifications')
      const list = data?.items || []
      setItems(list)
      // 未读 = 服务端总数 - 本次会话已读
      setUnread(Math.max(0, list.length - readCount.current))
    } catch {
      // 通知是辅助能力：静默失败，不打扰主流程
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 60_000)
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const handleOpenChange = (nextOpen) => {
    setOpen(nextOpen)
    if (nextOpen && unread > 0) {
      readCount.current = items.length
      setUnread(0)
    }
  }

  const content = (
    <div style={{ width: 360, maxHeight: 420, overflowY: 'auto' }}>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" style={{ margin: '24px 0' }} />
      ) : (
        <List
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{ alignItems: 'flex-start', cursor: 'pointer', paddingLeft: 12 }}
              onClick={() => {
                setOpen(false)
                if (item.actionUrl) navigate(item.actionUrl)
              }}
            >
              <div style={{ display: 'flex', gap: 8 }}>
                <span
                  style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: 6,
                    marginTop: 9, flex: '0 0 auto', background: LEVEL_COLOR[item.level] || '#999',
                  }}
                />
                <div>
                  <div style={{ fontWeight: 500 }}>{item.title}</div>
                  <div style={{ color: '#888', fontSize: 12, marginTop: 2 }}>{item.desc}</div>
                </div>
              </div>
            </List.Item>
          )}
        />
      )}
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <Badge count={unread} size="small" offset={[-2, 2]}>
        <BellOutlined style={{ fontSize: 18, cursor: 'pointer', padding: '0 4px' }} />
      </Badge>
    </Popover>
  )
}
