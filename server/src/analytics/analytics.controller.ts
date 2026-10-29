// server/src/analytics/analytics.controller.ts
// 埋点接收端点（FR-26）：
// - @Public() 匿名可记；存在 Bearer Token 时仅"尝试解析"，解析成功才回填租户/用户
// - 固定窗口 IP 频控（60 批/分钟）；单批 ≤50 条、体积 ≤32KB
// - sendBeacon 兼容：前端以 application/json 的 Blob 发送，Nest json parser 直接可收
import { Body, Controller, HttpCode, HttpException, HttpStatus, Ip, Post, Req } from '@nestjs/common'
import { ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { JwtService } from '@nestjs/jwt'
import { ExtractJwt } from 'passport-jwt'
import type { Request } from 'express'
import { Public } from '../auth/decorators/public.decorator'
import { RedisService } from '../redis/redis.service'
import {
  AnalyticsService,
  normalizeEvent,
  type EventIdentity,
  type NormalizedEvent,
} from './analytics.service.js'

const MAX_BATCH = 50
const MAX_BODY_BYTES = 32_000
const MAX_REQUESTS_PER_MIN = 60

@ApiTags('analytics')
@Controller('api/analytics')
export class AnalyticsController {
  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly service: AnalyticsService,
  ) {}

  @Public()
  @Post('track')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: '埋点事件上报（公开，支持匿名与 sendBeacon）',
    description: [
      '无需登录即可调用。请求体支持三种形态：单个事件对象、`{ events: [...] }` 批量（≤50 条、整体 ≤32KB）；信封可带 `anonymousId`（前端 localStorage 生成的持久匿名 ID）。',
      '身份解析：优先读 Authorization 头，sendBeacon 场景降级读信封 `token`；Token 合法才回填 user/tenant，失败一律按匿名处理（不返回 401）。IP 维度 60 次/分钟频控（Redis 故障 fail-open）。',
    ].join('\n'),
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        events: {
          type: 'array',
          maxItems: 50,
          description: '批量事件列表；也允许直接在请求体放置单个事件对象',
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: { type: 'string', description: '事件类型（如 page_view / sign_up / first_review_start / paywall_show / checkout_success 等，最长 50 字符）' },
              path: { type: 'string', description: '事件发生的页面路径（可选）' },
              props: { type: 'object', additionalProperties: true, description: '事件属性（persona/scene/utm/referrer 等）' },
            },
          },
        },
        type: { type: 'string', description: '单事件形态的事件类型' },
        path: { type: 'string', description: '单事件形态的页面路径（可选）' },
        props: { type: 'object', additionalProperties: true, description: '单事件形态的事件属性' },
        anonymousId: { type: 'string', minLength: 8, maxLength: 50, pattern: '^[A-Za-z0-9_-]+$', description: '匿名设备 ID（注册成功后用于关联访客期事件）' },
        token: { type: 'string', description: 'accessToken（仅 sendBeacon 无法带 Authorization 头时作为降级通道）' },
      },
    },
  })
  @ApiCreatedResponse({ description: '接收成功', schema: { type: 'object', properties: { accepted: { type: 'number' } } } })
  async track(@Req() req: Request, @Body() body: any, @Ip() ip: string) {
    // ① IP 固定窗口频控（按分钟分桶，键 TTL 65s 自动清理）
    // Redis 故障时 fail-open：埋点是 best-effort，跳过限流继续处理，避免抖动期事件全丢
    const bucket = Math.floor(Date.now() / 60_000)
    const rlKey = `rl:analytics:${ip}:${bucket}`
    const client = this.redis.getClient()
    let hits = 0
    try {
      hits = await client.incr(rlKey)
      if (hits === 1) await client.expire(rlKey, 65)
    } catch {
      hits = 0
    }
    if (hits > MAX_REQUESTS_PER_MIN) {
      throw new HttpException(
        { message: '埋点上报过于频繁' },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    // ② 体积校验（content-length 与实际序列化双保险）
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (contentLength > MAX_BODY_BYTES || JSON.stringify(body).length > MAX_BODY_BYTES) {
      throw new HttpException(
        { message: '上报数据体积超过 32KB 限制' },
        HttpStatus.PAYLOAD_TOO_LARGE,
      )
    }

    // ③ 单条 / 批量归一
    const list: any[] = Array.isArray(body?.events)
      ? body.events
      : (body && typeof body === 'object' ? [body] : [])
    if (list.length === 0) {
      throw new HttpException({ message: '事件内容为空' }, HttpStatus.BAD_REQUEST)
    }
    if (list.length > MAX_BATCH) {
      throw new HttpException(
        { message: `单批最多 ${MAX_BATCH} 条事件` },
        HttpStatus.BAD_REQUEST,
      )
    }

    // ④ 可选身份解析：有 Token 且合法才关联身份，失败/过期一律按匿名处理
    // sendBeacon 无法自定义 Authorization 头，前端把 access token 放在信封 body.token；
    // 两种来源都走同一套 JWT 验签，body 仅作为头缺失时的降级通道
    const identity = this.resolveIdentity(req, body)

    const events: NormalizedEvent[] = list.map((e) => normalizeEvent(e))
    return this.service.track(events, identity)
  }

  private resolveIdentity(req: Request, body?: any): EventIdentity {
    // 匿名设备 ID：前端 localStorage 生成，仅做长度/字符白名单校验后透传落库，
    // 用于把注册前的访客行为与注册后的用户关联（漏斗前置环节的数据源）
    let anonymousId: string | null = null
    if (typeof body?.anonymousId === 'string') {
      const raw = body.anonymousId.trim()
      if (raw.length >= 8 && raw.length <= 50 && /^[A-Za-z0-9_-]+$/.test(raw)) {
        anonymousId = raw
      }
    }
    try {
      let token = ExtractJwt.fromAuthHeaderAsBearerToken()(req as any)
      if (!token && typeof body?.token === 'string' && body.token.trim()) {
        token = body.token.trim()
      }
      if (!token) return { anonymousId }
      const payload = this.jwt.verify(token)
      if (payload?.sub && payload?.tenantId) {
        return { userId: payload.sub, tenantId: payload.tenantId, anonymousId }
      }
    } catch {
      // 匿名/过期 Token：静默降级，不抛 401
    }
    return { anonymousId }
  }
}
