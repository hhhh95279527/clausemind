// server/src/utils/sse.ts
// SSE 流式响应辅助：统一设置响应头 + send/end/error
import type { Response } from 'express'
import { sendSseError } from './errors.js'

export function initSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  // 开发环境关闭 nginx 缓冲（如果有的话）
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  // 心跳：AI 审查可能持续 1 分钟以上且期间无业务事件，
  // 定时发 SSE 注释帧保活，防止 nginx/浏览器/中转链路因静默超时掐断连接
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': hb\n\n')
      // 对抗反向代理/压缩层缓冲（main.ts 已排除 SSE gzip，这里再兜底一次）
      ;(res as any).flush?.()
    }
  }, 15000)
  // 连接意外关闭时清理心跳，避免事件循环悬挂
  res.on('close', () => clearInterval(heartbeat))

  return {
    send(event: string, data: unknown) {
      if (!res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        ;(res as any).flush?.()
      }
    },
    end() {
      clearInterval(heartbeat)
      if (!res.writableEnded) res.end()
    },
    error(err: unknown) {
      clearInterval(heartbeat)
      sendSseError(res, err)
    },
  }
}
