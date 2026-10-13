import { Controller, Get, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { DashboardService } from './dashboard.service.js'

@ApiTags('dashboard')
@ApiBearerAuth('bearer')
@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  @ApiOperation({
    summary: '合规仪表盘聚合数据',
    description: '返回风险概览、合同到期/试用期到期提醒等企业合规仪表盘卡片数据（按当前租户聚合）。',
  })
  async summary(@Req() req: Request) {
    return this.dashboard.summary((req as any).user.tenantId)
  }
}
