// server/src/monitor/monitor.controller.ts
// 用量看板：API 调用统计、Token 消耗、缓存命中率、成本
import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { MonitorService } from './monitor.service'
import { BillingService } from './billing.service.js'
import { QuotaService } from '../observability/quota.service.js'

@ApiTags('monitor')
@ApiBearerAuth('bearer')
@Controller('api/monitor')
export class MonitorController {
  constructor(
    private readonly monitorService: MonitorService,
    private readonly billingService: BillingService,
    private readonly quotaService: QuotaService,
  ) {}

  // ── GET /api/monitor/quota ─────────────────────────────────────
  @Get('quota')
  @ApiOperation({ summary: '本月配额用量', description: '返回当前租户本月 LLM 调用次数/Token 额度使用量与剩余额度。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  quota(@Req() req: Request) {
    return this.quotaService.getUsage((req as any).user.tenantId)
  }

  // ── GET /api/monitor/billing ───────────────────────────────────
  @Get('billing')
  @ApiOperation({ summary: '配额账单', description: '本月配额进度、按天峰谷计价费用、功能占比、历史账期与超额记录。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  billing(@Req() req: Request) {
    return this.billingService.getBilling((req as any).user.tenantId)
  }

  // ── GET /api/monitor/traces ────────────────────────────────────
  @Get('traces')
  @ApiOperation({ summary: '调用链路列表', description: 'Trace 瀑布页左侧列表，分页 + feature/status 过滤，强制当前租户隔离。' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数（1-100，默认 20）' })
  @ApiQuery({ name: 'feature', required: false, description: '功能过滤，如 contract_review / knowledge / agent' })
  @ApiQuery({ name: 'status', required: false, description: '状态过滤，如 success / error' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  traces(
    @Req() req: Request,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('feature') feature?: string,
    @Query('status') status?: string,
  ) {
    const tenantId = (req as any).user.tenantId
    return this.monitorService.listTraces(tenantId, {
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)),
      feature,
      status,
    })
  }

  // ── GET /api/monitor/traces/:id ───────────────────────────────
  @Get('traces/:id')
  @ApiOperation({ summary: '调用链路详情（瀑布）', description: '含按开始时间升序的 LLM/TOOL/RETRIEVER spans、耗时占比、失败高亮；点击 span 的明细数据由前端按需展开。' })
  @ApiParam({ name: 'id', description: 'Trace ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async traceDetail(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const detail = await this.monitorService.getTraceDetail(tenantId, id)
    if (!detail) throw new NotFoundException('链路不存在或无权查看')
    return detail
  }
}
