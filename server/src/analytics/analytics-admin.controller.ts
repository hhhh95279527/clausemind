// server/src/analytics/analytics-admin.controller.ts
// 埋点运营看板接口（FR-26，ADMIN）：转化漏斗 + 套餐/persona/场景维度下钻
import { BadRequestException, Controller, Get, Query } from '@nestjs/common'
import { Roles } from '../auth/decorators/roles.decorator'
import { AnalyticsService } from './analytics.service.js'

const MAX_RANGE_DAYS = 366

/** 解析时间范围：默认近 30 天（[from, to]，to 补到当日末尾由调用方传 ISO 即可） */
function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const now = new Date()
  const end = to ? new Date(to) : now
  const start = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 3600 * 1000)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('时间范围格式不正确')
  }
  if (start > end) throw new BadRequestException('起始时间不能晚于结束时间')
  if ((end.getTime() - start.getTime()) / (24 * 3600 * 1000) > MAX_RANGE_DAYS) {
    throw new BadRequestException(`时间范围不能超过 ${MAX_RANGE_DAYS} 天`)
  }
  return { from: start, to: end }
}

@Controller('api/admin/analytics')
@Roles('ADMIN')
export class AnalyticsAdminController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('funnel')
  funnel(@Query('from') from?: string, @Query('to') to?: string) {
    const range = parseRange(from, to)
    return this.analytics.getFunnel(range.from, range.to)
  }

  @Get('breakdown')
  breakdown(
    @Query('dim') dim = 'persona',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (dim !== 'persona' && dim !== 'plan' && dim !== 'scene') {
      throw new BadRequestException('dim 仅支持 plan / persona / scene')
    }
    const range = parseRange(from, to)
    return this.analytics.getBreakdown(range.from, range.to, dim)
  }
}
