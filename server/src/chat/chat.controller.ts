// server/src/chat/chat.controller.ts
// 对话控制器：流式对话 + 精确缓存（租户隔离）+ DB 会话历史
// 可观测：每次请求一条 Trace，模型调用自动产生 Span；配额超额 429
import { Body, Controller, Delete, ForbiddenException, Get, OnModuleInit, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { chatModel } from '../services/model.js'
import { cache } from '../services/cache.js'
import {
  getHistory, trimHistory,
  listSessions, createSession, getSessionDetail, setDatabase,
} from '../services/chat/memory.js'
import { MonitorService } from '../monitor/monitor.service'
import { DatabaseService } from '../database/database.service'
import { TraceService } from '../observability/trace.service.js'
import { QuotaService } from '../observability/quota.service.js'
import { logger } from '../utils/logger.js'
import { initSse } from '../utils/sse'

// 内置角色预设
const ROLES: Record<string, string> = {
  default: '你是 ClauseMind AI，一个严谨的智能办公助手，回答简洁专业。',
  tech:    '你是资深技术顾问，精通 Vue3、React、Node.js 等技术栈。回答要有代码示例，说明清楚原理。',
  legal:   '你是法务助理，熟悉合同法、知识产权、劳动合同。回答严谨，不编造法条，必要时建议咨询专业律师。',
}

interface ChatDto {
  message: string
  sessionId?: string
  role?: string
  contractId?: string
}

@Controller('api/chat')
export class ChatController implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly tracer: TraceService,
    private readonly quota: QuotaService,
  ) {}

  onModuleInit() {
    // 把 Prisma 注入到函数式 memory 模块
    setDatabase(this.db)
  }

  // ── POST /api/chat/stream ──────────────────────────────────────
  @Post('stream')
  async stream(@Req() req: Request, @Body() body: ChatDto, @Res() res: Response) {
    const userId: string = (req as any).user.userId
    const tenantId: string = (req as any).user.tenantId
    const { message, role = 'default', contractId } = body
    let { sessionId } = body

    // 关联合同必须属于本租户，防止把消息挂到他人合同上
    if (contractId) {
      const owned = await this.db.contract.findFirst({
        where: { id: contractId, tenantId },
        select: { id: true },
      })
      if (!owned) throw new ForbiddenException('无权关联该合同')
    }

    const sse = initSse(res)
    const send = sse.send
    let createdSessionId: string | null = null

    try {
      await this.tracer.run(
        { feature: 'chat', name: `对话：${message.slice(0, 30)}`, tenantId, userId },
        async ({ ctx, callbacks, markCacheHit }) => {
          // 1. 会话：未传则新建（首条消息作为标题），传了则校验归属
          if (!sessionId) {
            const session = await createSession(userId, message.slice(0, 20) || '新对话', role)
            sessionId = session.id
            createdSessionId = session.id
          } else {
            const owned = await this.db.chatSession.findFirst({ where: { id: sessionId, userId } })
            if (!owned) throw new ForbiddenException('会话不存在或无权访问')
          }

          // 2. system prompt = 角色预设
          const baseSystem = ROLES[role] || ROLES.default
          const systemPrompt = baseSystem

          // 3. 精确缓存（命名空间=租户，杜绝跨租户命中）
          const cached = await cache.get(systemPrompt, message, tenantId)
          if (cached) {
            logger.info('cache hit', { sessionId, tenantId })
            markCacheHit(cached.tokens || 0)
            send('start', { sessionId })
            send('cache_hit', {})
            // 命中也落库，保证会话连续
            await this.db.message.create({
              data: { sessionId, userId, role: 'USER', content: message, feature: 'chat', contractId },
            })
            await this.db.message.create({
              data: { sessionId, userId, role: 'ASSISTANT', content: cached.content, fromCache: true, feature: 'chat', contractId },
            })
            // 模拟流式，保持前端体验一致
            const chars = [...cached.content]
            for (let i = 0; i < chars.length; i += 3) {
              send('token', { token: chars.slice(i, i + 3).join('') })
              await new Promise((r) => setTimeout(r, 6))
            }
            send('done', { sessionId, fromCache: true, savedTokens: cached.tokens || 0 })
            return
          }

          // 4. 租户月度配额断言（缓存命中零成本，放在缓存检查之后）
          await this.quota.assert(tenantId)

          // 5. 历史消息 + token 裁剪
          const history = await getHistory(sessionId)
          const trimmed = trimHistory(history, 2000)
          const messages = [
            new SystemMessage(systemPrompt),
            ...trimmed,
            new HumanMessage(message),
          ]

          send('start', { sessionId })

          // 6. 流式调用（callbacks 自动产出 LLM Span 与峰谷成本计量）
          let fullReply = ''
          const stream = await chatModel.stream(messages, { callbacks })
          for await (const chunk of stream) {
            if (chunk.content) {
              fullReply += chunk.content
              send('token', { token: chunk.content })
            }
          }

          // token 用量由 observer 聚合到 ctx（Agent 多轮/重试也准确）
          const inputTokens = ctx.usage.inputTokens
          const outputTokens = ctx.usage.outputTokens

          // 7. 落库：用户消息 + 助手回复
          await this.db.message.createMany({
            data: [
              { sessionId, userId, role: 'USER' as const, content: message, feature: 'chat', contractId },
              {
                sessionId, userId, role: 'ASSISTANT' as const, content: fullReply,
                inputTokens, outputTokens, feature: 'chat', contractId,
              },
            ],
          })
          await this.db.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } })

          // 8. 写缓存
          await cache.set(systemPrompt, message, { content: fullReply, tokens: inputTokens + outputTokens }, tenantId)

          send('done', { sessionId, fromCache: false, inputTokens, outputTokens })
        },
      )
    } catch (err) {
      logger.error('chat error', { error: (err as Error).message, traceId: (req as any).traceId })
      // 本次新建的会话若一条消息都没落库（如模型调用失败/配额拦截），清理掉，避免脏空会话
      if (createdSessionId) {
        const count = await this.db.message.count({ where: { sessionId: createdSessionId } })
        if (count === 0) {
          await this.db.chatSession.delete({ where: { id: createdSessionId } }).catch(() => {})
        }
      }
      sse.error(err)
    } finally {
      sse.end()
    }
  }

  // ── GET /api/chat/sessions ─────────────────────────────────────
  @Get('sessions')
  async sessions(@Req() req: Request) {
    return { sessions: await listSessions((req as any).user.userId) }
  }

  // ── DELETE /api/chat/sessions/:id ─────────────────────────────
  @Delete('sessions/:id')
  async clearSession(@Req() req: Request, @Param('id') id: string) {
    const owned = await this.db.chatSession.findFirst({ where: { id, userId: (req as any).user.userId } })
    if (!owned) throw new ForbiddenException('会话不存在或无权访问')
    // 消息外键 onDelete: Cascade，随会话一并删除
    await this.db.chatSession.delete({ where: { id } })
    return { success: true }
  }

  // ── GET /api/chat/profile ─────────────────────────────────────
  // 用户画像已下线，保留空对象响应兼容旧前端调用
  @Get('profile')
  profile() {
    return {}
  }

  @Get('roles')
  roles() {
    return {
      roles: [
        { id: 'default', label: '通用助手', icon: '🤖', desc: '日常问答、通用任务' },
        { id: 'tech',    label: '技术顾问', icon: '💻', desc: '代码、架构、技术方案' },
        { id: 'legal',   label: '法务助理', icon: '⚖️', desc: '合同、合规、法律问题' },
      ],
    }
  }
}
