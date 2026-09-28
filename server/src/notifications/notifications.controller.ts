// server/src/notifications/notifications.controller.ts
import { Controller, Get, Req } from '@nestjs/common'
import type { Request } from 'express'
import { NotificationsService } from './notifications.service.js'

@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.notifications.list((req as any).user.tenantId)
  }
}
