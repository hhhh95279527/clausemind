// server/src/analytics/analytics.service.ts
// 自研埋点服务（FR-26）：事件落库 + ADMIN 漏斗 / 维度聚合
// 红线：只采事件与属性元数据，props 在入库前做两层清洗——
//   ① 敏感语义键（password/token/api_key…，与 AuditService 同款名单）直接删除；
//   ② 合同/风险正文字段键（content/rawText/markdown…）直接删除。
import { BadRequestException, Injectable } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'

// ── 事件类型白名单 ──────────────────────────────────────────────
// 内置：PV / 点击 / 性能 / 异常 / API 异常 / SSE 断连
// 增长：注册 → 首审 → 看到结果 → 付费墙曝光 → 点击升级 → 支付成功
// 飞书：测试发送结果、业务推送结果
export const EVENT_TYPES = new Set<string>([
  'page_view', 'click', 'performance', 'error', 'api_error', 'sse_disconnect',
  'sign_up', 'first_review_start', 'first_result_seen',
  'paywall_show', 'paywall_click_upgrade', 'checkout_success',
  'feishu_test_sent', 'feishu_notify_sent', 'playbook_rule_created',
])

// 转化漏斗六步（顺序即展示顺序，不可调整）
export const FUNNEL_STEPS = [
  'sign_up',
  'first_review_start',
  'first_result_seen',
  'paywall_show',
  'paywall_click_upgrade',
  'checkout_success',
] as const

export interface EventIdentity {
  userId?: string | null
  tenantId?: string | null
}

export interface NormalizedEvent {
  type: string
  path?: string
  props?: Prisma.InputJsonValue
}

// ── props 清洗常量 ──────────────────────────────────────────────
// 语义包含式匹配：不再要求键边界，accessToken / mySecret2 / jwt 等驼峰变体同样命中
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|jwt|api[_-]?key|credential|private[_-]?key|authorization)/i
// 合同正文/风险全文语义键：键名包含 content/markdown/rawtext 等正文语义词，
// 或独立的 text/body 词（防误伤 context，故 text/body 需边界匹配）
const CONTENT_KEY = /(content|markdown|rawtext|fulltext|html|analysis|original|rewritten|suggestion|clausetext|contracttext|risktext|sourcecode|(^|[._-])(text|body)([._-]|$))/i
const MAX_DEPTH = 3      // props 嵌套上限（元数据不需要深结构）
const MAX_KEYS = 20      // 单事件 props 键上限
const MAX_STRING = 500   // 字符串值上限
const PROPS_BYTES = 4000 // props 序列化体积上限

/**
 * 清洗单条 props：递归删除敏感/正文字段键，限制深度、键数与体积。
 * 返回 undefined 表示无可用属性。
 */
export function sanitizeProps(input: unknown, depth = 0): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined

  const out: Record<string, unknown> = {}
  let estimated = 2 // "{}"
  let keyCount = 0

  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    // ① 敏感键 ② 正文字段键：直接剥离，不留掩码
    if (SENSITIVE_KEY.test(k) || CONTENT_KEY.test(k)) continue
    if (keyCount >= MAX_KEYS) break

    const cleaned = cleanValue(v, depth)
    if (cleaned === undefined) continue

    const piece = JSON.stringify(k).length + JSON.stringify(cleaned).length + 1
    if (estimated + piece > PROPS_BYTES) continue
    estimated += piece
    out[k] = cleaned
    keyCount += 1
  }

  return Object.keys(out).length > 0 ? out : undefined
}

function cleanValue(v: unknown, depth: number): unknown {
  if (v === null) return null
  const t = typeof v
  if (t === 'string') {
    const s = v as string
    return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s
  }
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'boolean') return v
  if (t !== 'object' || depth >= MAX_DEPTH) return undefined
  if (Array.isArray(v)) {
    return v.slice(0, 20)
      .map((x) => cleanValue(x, depth + 1))
      .filter((x) => x !== undefined)
  }
  return sanitizeProps(v, depth + 1)
}

/** 归一单条事件：type 白名单校验 + path 截断 + props 清洗 */
export function normalizeEvent(raw: any): NormalizedEvent {
  const type = String(raw?.type ?? raw?.eventType ?? '').trim().toLowerCase()
  if (!type || type.length > 50) {
    throw new BadRequestException('事件 type 缺失或非法')
  }
  if (!EVENT_TYPES.has(type)) {
    throw new BadRequestException(`未知事件类型: ${type}`)
  }

  let path: string | undefined
  const rawPath = raw.path ?? raw.pathname ?? raw.url
  if (typeof rawPath === 'string' && rawPath.trim()) {
    path = rawPath.slice(0, 500)
  }

  const props = sanitizeProps(raw.props)
  return {
    type,
    ...(path && { path }),
    ...(props && { props: props as Prisma.InputJsonValue }),
  }
}

interface FunnelRow {
  type: string
  count: number
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly db: DatabaseService) {}

  async track(events: NormalizedEvent[], identity: EventIdentity) {
    if (events.length === 0) throw new BadRequestException('没有可记录的事件')
    await this.db.analyticsEvent.createMany({
      data: events.map((e) => ({
        type: e.type,
        path: e.path,
        props: e.props,
        userId: identity.userId ?? null,
        tenantId: identity.tenantId ?? null,
      })),
    })
    return { accepted: events.length }
  }

  /** 六步漏斗：COUNT DISTINCT user_id + 相邻/相对注册转化率 */
  async getFunnel(from: Date, to: Date) {
    const rows: FunnelRow[] = await this.db.$queryRaw(Prisma.sql`
      SELECT type, COUNT(DISTINCT user_id)::int AS count
      FROM analytics_events
      WHERE type = ANY(${FUNNEL_STEPS}::text[])
        AND created_at >= ${from}
        AND created_at <= ${to}
      GROUP BY type
    `)
    const counts = new Map(rows.map((r) => [r.type, Number(r.count)]))
    const top = counts.get(FUNNEL_STEPS[0]) ?? 0
    const steps = FUNNEL_STEPS.map((step, i) => {
      const count = counts.get(step) ?? 0
      const prev = i === 0 ? null : (counts.get(FUNNEL_STEPS[i - 1]) ?? 0)
      return {
        step,
        count,
        fromPrev: prev === null || prev === 0 ? null : Number((count / prev).toFixed(4)),
        fromTop: top === 0 ? null : Number((count / top).toFixed(4)),
      }
    })
    return { from: from.toISOString(), to: to.toISOString(), steps }
  }

  /** 维度下钻：plan（join users/tenants）/ persona / scene（从事件 props 取） */
  async getBreakdown(from: Date, to: Date, dim: 'persona' | 'plan' | 'scene') {
    const steps = FUNNEL_STEPS
    let rows: Array<{ value: string | null; type: string; count: number }>

    if (dim === 'plan') {
      rows = await this.db.$queryRaw(Prisma.sql`
        SELECT t.plan AS value, e.type AS type, COUNT(DISTINCT e.user_id)::int AS count
        FROM analytics_events e
        JOIN users u ON u.id = e.user_id
        JOIN tenants t ON t.id = u.tenant_id
        WHERE e.type = ANY(${steps}::text[])
          AND e.created_at >= ${from}
          AND e.created_at <= ${to}
        GROUP BY t.plan, e.type
      `)
    } else {
      // persona / scene：从对应事件的 props JSON 中取值
      const metaType = dim === 'persona' ? 'sign_up' : 'first_review_start'
      rows = await this.db.$queryRaw(Prisma.sql`
        WITH meta AS (
          SELECT user_id, props->>${dim} AS value
          FROM analytics_events
          WHERE type = ${metaType} AND user_id IS NOT NULL
        )
        SELECT m.value AS value, e.type AS type, COUNT(DISTINCT e.user_id)::int AS count
        FROM analytics_events e
        JOIN meta m ON m.user_id = e.user_id
        WHERE e.type = ANY(${steps}::text[])
          AND e.created_at >= ${from}
          AND e.created_at <= ${to}
          AND m.value IS NOT NULL
        GROUP BY m.value, e.type
      `)
    }

    const byValue = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const value = r.value ?? '(空)'
      if (!byValue.has(value)) byValue.set(value, {})
      byValue.get(value)![r.type] = Number(r.count)
    }
    return {
      dim,
      rows: [...byValue.entries()].map(([value, counts]) => ({ value, counts })),
    }
  }
}
