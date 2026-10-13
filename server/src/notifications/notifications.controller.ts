import { Controller, Get, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { NotificationsService } from './notifications.service.js'

@ApiTags('notifications')
@ApiBearerAuth('bearer')
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: '站内通知列表',
    description: '实时计算当前租户的站内通知（审查结果、到期提醒、套餐账单等）。',
  })
  list(@Req() req: Request) {
    return this.notifications.list((req as any).user.tenantId)
  }
}
