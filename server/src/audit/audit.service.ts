// server/src/audit/audit.service.ts
// 审计日志服务：记录关键操作（detail 落库前深度脱敏，写入失败不影响业务）
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../database/database.service'
import { logger } from '../utils/logger.js'

// ── 审计 detail 脱敏 ────────────────────────────────────────────
// 命中敏感语义的键一律掩码（passwordHash/accessToken/refreshToken/apiKey 等）；
// 对递归深度、键/元素数量、字符串长度设上限，并处理循环引用，防恶意/异常 detail 撑爆审计表。
const REDACTED = '***REDACTED***'
const SENSITIVE_KEY = /(^|[._-])(password|passwd|pwd|passwordhash|secret|authorization|api[_-]?key|credential|private[_-]?key|token)([._-]|$|hash)/i
const MAX_DEPTH = 6
const MAX_KEYS = 200
const MAX_STRING = 10_000

function sanitizeDetail(value: any, depth = 0, seen = new WeakSet<object>()): any {
  if (value === null || value === undefined) return value
  if (typeof value === 'function') return undefined
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return '[Buffer]'
    if (value instanceof Error) return { name: value.name, message: value.message }
    if (depth >= MAX_DEPTH) return '[MaxDepth]'
    if (seen.has(value)) return '[Circular]'
    seen.add(value)

    if (Array.isArray(value)) {
      return value.slice(0, MAX_KEYS).map((v) => sanitizeDetail(v, depth + 1, seen))
    }
    const out: Record<string, any> = {}
    let i = 0
    for (const [k, v] of Object.entries(value)) {
      if (i++ >= MAX_KEYS) { out.__truncated__ = true; break }
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED
      } else {
        const cleaned = sanitizeDetail(v, depth + 1, seen)
        if (cleaned !== undefined) out[k] = cleaned
      }
    }
    return out
  }
  return String(value)
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * 记录审计事件（detail 落库前自动深度脱敏）
   */
  async log(params: {
    userId?: string
    action: string
    resource: string
    resourceId?: string
    detail?: any
    ip?: string
    userAgent?: string
    tenantId?: string
  }) {
    try {
      await this.db.auditLog.create({
        data: {
          userId: params.userId,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId,
          detail: params.detail === undefined ? undefined : sanitizeDetail(params.detail),
          ip: params.ip,
          userAgent: params.userAgent,
          tenantId: params.tenantId,
        },
      })
    } catch (err) {
      // 审计日志写入失败不应影响业务，只打日志
      logger.error('audit log write failed', { error: (err as Error).message })
    }
  }
}
