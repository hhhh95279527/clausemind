// server/src/platform/platform.controller.ts
// 平台超管接口（/api/platform）：全部 @Roles('PLATFORM_ADMIN')，登录端点除外
import { Body, Controller, Get, Param, Post, Put, Req, Query } from '@nestjs/common'
import type { Request } from 'express'
import { PlatformService } from './platform.service.js'
import { OrdersService } from '../billing/orders.service.js'
import { Roles } from '../auth/decorators/roles.decorator.js'
import { Public } from '../auth/decorators/public.decorator.js'

@Controller('api/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly orders: OrdersService,
  ) {}

  /** 平台超管登录（公开端点；独立账号体系，与租户用户不共用） */
  @Public()
  @Post('auth/login')
  login(@Body() body: { username?: string; password?: string }) {
    return this.platform.login(body.username || '', body.password || '')
  }

  @Roles('PLATFORM_ADMIN')
  @Get('overview')
  overview() {
    return this.platform.overview()
  }

  @Roles('PLATFORM_ADMIN')
  @Get('tenants')
  listTenants() {
    return this.platform.listTenants()
  }

  @Roles('PLATFORM_ADMIN')
  @Post('tenants')
  createTenant(@Body() body: { name?: string; plan?: string; adminUsername?: string; adminPassword?: string }) {
    return this.platform.createTenant(body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @Put('tenants/:id/plan')
  updateTenantPlan(@Param('id') id: string, @Body() body: { plan?: string; planExpiresAt?: string | null }) {
    return this.platform.updateTenantPlan(id, body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @Put('tenants/:id/status')
  setTenantStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.platform.setTenantStatus(id, body?.status || '')
  }

  @Roles('PLATFORM_ADMIN')
  @Get('tenants/:id/users')
  listTenantUsers(@Param('id') id: string) {
    return this.platform.listTenantUsers(id)
  }

  @Roles('PLATFORM_ADMIN')
  @Put('tenants/:id/users/:userId')
  updateTenantUser(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { role?: string; status?: string },
  ) {
    return this.platform.updateTenantUser(id, userId, body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @Post('tenants/:id/users/:userId/reset-password')
  resetPassword(@Param('id') id: string, @Param('userId') userId: string) {
    return this.platform.resetTenantUserPassword(id, userId)
  }

  /** 当前登录的超管信息（前端控制台鉴权探测用） */
  @Roles('PLATFORM_ADMIN')
  @Get('me')
  me(@Req() req: Request) {
    return { username: (req as any).user?.username }
  }

  // ── 转账订单人工确认 ──────────────────────────────────────────

  @Roles('PLATFORM_ADMIN')
  @Get('transfer-orders')
  listTransferOrders(@Query('status') status?: string) {
    return this.orders.listTransferOrders(status || 'PENDING')
  }

  @Roles('PLATFORM_ADMIN')
  @Post('transfer-orders/:id/confirm')
  confirmTransferOrder(@Param('id') id: string, @Req() req: Request) {
    return this.orders.confirmTransferOrder(id, (req as any).user?.username || 'platform')
  }

  @Roles('PLATFORM_ADMIN')
  @Post('transfer-orders/:id/reject')
  rejectTransferOrder(@Param('id') id: string, @Req() req: Request, @Body() body: { reason?: string }) {
    return this.orders.rejectTransferOrder(id, (req as any).user?.username || 'platform', body.reason || '')
  }
}
