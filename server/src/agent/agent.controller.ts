// server/src/agent/agent.controller.ts
// Agent 控制器：配额断言 → Trace 包裹 → SSE 流式推送每一步
import { BadRequestException, Body, Controller, Get, OnModuleInit, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { runAgent, getToolList } from '../services/agent/agent.js'
import { setToolsDatabase } from '../services/agent/tools.js'
import { DatabaseService } from '../database/database.service.js'
import { TraceService } from '../observability/trace.service.js'
import { QuotaService } from '../observability/quota.service.js'
import { logger } from '../utils/logger.js'
import { initSse } from '../utils/sse'

@Controller('api/agent')
export class AgentController implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly tracer: TraceService,
    private readonly quota: QuotaService,
  ) {}

  onModuleInit() {
    setToolsDatabase(this.db)
  }

  // ── POST /api/agent/run ────────────────────────────────────────
  @Post('run')
  async run(@Req() req: Request, @Body() body: { task: string }, @Res() res: Response) {
    const { task } = body ?? {}
    const userId: string = (req as any).user.userId
    const tenantId: string = (req as any).user.tenantId

    if (!task?.trim()) throw new BadRequestException('任务不能为空')
    if (task.length > 2000) throw new BadRequestException('任务描述过长，请简洁描述')

    const sse = initSse(res)
    const send = sse.send

    try {
      await this.tracer.run(
        { feature: 'agent', name: `Agent 任务：${task.slice(0, 30)}`, tenantId, userId },
        async ({ callbacks }) => {
          await this.quota.assert(tenantId) // 放在 trace 内：被拦截的调用也留有审计痕迹
          send('start', { task, timestamp: new Date().toISOString() })
          await runAgent(task, { callbacks }, (type: string, data: unknown) => send(type, data))
        },
      )
    } catch (err) {
      logger.error('agent route error', { error: (err as Error).message, traceId: (req as any).traceId })
      sse.error(err)
    } finally {
      sse.end()
    }
  }

  // ── GET /api/agent/tools ───────────────────────────────────────
  @Get('tools')
  tools() {
    return { tools: getToolList() }
  }

  // ── GET /api/agent/examples ────────────────────────────────────
  @Get('examples')
  examples() {
    return {
      examples: [
        { title: '法规核查', task: '劳动合同约定试用期6个月、试用期违约金5万元，先查法规库确认是否合法，给出条文依据', icon: '⚖️' },
        { title: '合同盘点', task: '查一下我上传过哪些合同，哪些还没完成人工终审，分别还有多少未处理的风险', icon: '📋' },
        { title: '到期预警', task: '看看台账里未来60天有哪些员工合同到期，按剩余天数排序列个清单，并给出续签动作建议', icon: '⏰' },
        { title: '风险复盘', task: '统计我最近审查的合同里高风险问题主要集中在哪些类别，结合平台审查规则给出起草合同时的规避建议', icon: '📊' },
        { title: '范本推荐', task: '我们要招一名在校实习生，帮我找平台有没有合适的实习范本，并查法规说明实习协议与劳动合同的核心区别', icon: '📑' },
      ],
    }
  }
}
