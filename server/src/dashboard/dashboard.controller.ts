// server/src/dashboard/dashboard.controller.ts
import { Controller, Get, Req } from '@nestjs/common'
import type { Request } from 'express'
import { DashboardService } from './dashboard.service.js'

@Controller('api/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('summary')
  async summary(@Req() req: Request) {
    return this.dashboard.summary((req as any).user.tenantId)
  }
}
