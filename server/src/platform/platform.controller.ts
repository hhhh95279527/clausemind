// server/src/platform/platform.controller.ts
// 平台超管接口（/api/platform）：全部 @Roles('PLATFORM_ADMIN')，登录端点除外
import { Body, Controller, Get, Param, Post, Put, Req, Query, NotFoundException } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger'
import type { Request } from 'express'
import { PlatformService } from './platform.service.js'
import { OrdersService } from '../billing/orders.service.js'
import { MonitorService } from '../monitor/monitor.service.js'
import { AnalyticsService } from '../analytics/analytics.service.js'
import { Roles } from '../auth/decorators/roles.decorator.js'
import { Public } from '../auth/decorators/public.decorator.js'

@ApiTags('platform')
@Controller('api/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly orders: OrdersService,
    private readonly monitor: MonitorService,
    private readonly analytics: AnalyticsService,
  ) {}

  /** 平台超管登录（公开端点；独立账号体系，与租户用户不共用） */
  @Public()
  @Post('auth/login')
  @ApiOperation({
    summary: '平台超管登录（公开）',
    description: '独立于租户用户的账号体系（独立 platform_admins 表、独立 JWT type=platform）。账号不存在与密码错误返回相同错误，防止账号枚举。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string', description: '平台超管用户名' },
        password: { type: 'string', description: '平台超管密码' },
      },
    },
  })
  login(@Body() body: { username?: string; password?: string }) {
    return this.platform.login(body.username || '', body.password || '')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('overview')
  @ApiOperation({ summary: '运营总览', description: '平台运营总览数据（租户数、关键增长与用量指标）。' })
  overview() {
    return this.platform.overview()
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('tenants')
  @ApiOperation({ summary: '全量租户列表', description: '返回平台全部租户及其套餐、订阅到期时间、状态等。' })
  listTenants() {
    return this.platform.listTenants()
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('tenants')
  @ApiOperation({
    summary: '代开新租户企业空间',
    description: '创建租户及其管理员账号。空间类型按套餐自动判定：TEAM/ENTERPRISE→TEAM 空间，FREE/PERSONAL→PERSONAL 空间。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'plan', 'adminUsername', 'adminPassword'],
      properties: {
        name: { type: 'string', description: '租户（企业）名称' },
        plan: { type: 'string', enum: ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'], description: '初始套餐' },
        adminUsername: { type: 'string', description: '租户管理员用户名' },
        adminPassword: { type: 'string', description: '租户管理员初始密码' },
      },
    },
  })
  createTenant(@Body() body: { name?: string; plan?: string; adminUsername?: string; adminPassword?: string }) {
    return this.platform.createTenant(body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Put('tenants/:id/plan')
  @ApiOperation({ summary: '调整租户套餐/订阅到期时间', description: '设置套餐与到期时间（可传 null 清空）；空间类型随套餐同步判定。' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['plan'],
      properties: {
        plan: { type: 'string', enum: ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'] },
        planExpiresAt: { type: 'string', format: 'date-time', nullable: true, description: '套餐到期时间 ISO 字符串，null 清空' },
      },
    },
  })
  updateTenantPlan(@Param('id') id: string, @Body() body: { plan?: string; planExpiresAt?: string | null }) {
    return this.platform.updateTenantPlan(id, body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Put('tenants/:id/status')
  @ApiOperation({ summary: '停用/启用租户', description: '停用后该租户成员无法登录使用。' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: { status: { type: 'string', enum: ['ACTIVE', 'DISABLED'], description: '目标状态' } },
    },
  })
  setTenantStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.platform.setTenantStatus(id, body?.status || '')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('tenants/:id/users')
  @ApiOperation({ summary: '租户成员管理：成员列表', description: '查看指定租户的全部成员。' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  listTenantUsers(@Param('id') id: string) {
    return this.platform.listTenantUsers(id)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Put('tenants/:id/users/:userId')
  @ApiOperation({ summary: '租户成员管理：修改成员角色/状态' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  @ApiParam({ name: 'userId', description: '目标成员用户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'USER', 'READONLY'] },
        status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
      },
    },
  })
  updateTenantUser(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() body: { role?: string; status?: string },
  ) {
    return this.platform.updateTenantUser(id, userId, body || {})
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('tenants/:id/users/:userId/reset-password')
  @ApiOperation({ summary: '租户成员管理：重置成员密码', description: '由平台超管重置指定成员密码并返回新凭证。' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  @ApiParam({ name: 'userId', description: '目标成员用户 ID' })
  resetPassword(@Param('id') id: string, @Param('userId') userId: string) {
    return this.platform.resetTenantUserPassword(id, userId)
  }

  // ── 转账订单人工确认 ──────────────────────────────────────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('transfer-orders')
  @ApiOperation({ summary: '转账订单列表', description: '按状态筛选转账订单，默认 PENDING。' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'CONFIRMED', 'REJECTED'], description: '订单状态，默认 PENDING' })
  listTransferOrders(@Query('status') status?: string) {
    return this.orders.listTransferOrders(status || 'PENDING')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('transfer-orders/:id/confirm')
  @ApiOperation({ summary: '确认转账到账', description: '确认后为租户开通对应套餐（续费自原到期日顺延）；重复确认同一单号返回 409。' })
  @ApiParam({ name: 'id', description: '转账订单 ID' })
  confirmTransferOrder(@Param('id') id: string, @Req() req: Request) {
    return this.orders.confirmTransferOrder(id, (req as any).user?.username || 'platform')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('transfer-orders/:id/reject')
  @ApiOperation({ summary: '驳回转账订单', description: '驳回时必须填写原因。' })
  @ApiParam({ name: 'id', description: '转账订单 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['reason'],
      properties: { reason: { type: 'string', description: '驳回原因（必填）' } },
    },
  })
  rejectTransferOrder(@Param('id') id: string, @Req() req: Request, @Body() body: { reason?: string }) {
    return this.orders.rejectTransferOrder(id, (req as any).user?.username || 'platform', body.reason || '')
  }

  // ── 埋点漏斗（平台级，支持按套餐过滤：个人版/企业版/全部）─────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('analytics/funnel')
  @ApiOperation({
    summary: '六步增长漏斗',
    description: '按近 30 天数据统计（可用 from/to 覆盖），以注册事件为漏斗起始门槛，无注册事件时为空态；支持按套餐过滤。',
  })
  @ApiQuery({ name: 'plan', required: false, description: '按套餐过滤' })
  @ApiQuery({ name: 'from', required: false, description: '起始时间 ISO 字符串，默认 30 天前' })
  @ApiQuery({ name: 'to', required: false, description: '结束时间 ISO 字符串，默认当前' })
  funnel(
    @Query('plan') plan?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseRange(from, to)
    return this.analytics.getFunnel(range.from, range.to, plan)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('analytics/breakdown')
  @ApiOperation({ summary: '漏斗维度下钻分布', description: '按 persona（注册身份）/ plan（套餐）/ scene（审查场景）维度对漏斗事件做分布统计，非法 dim 回退 plan。' })
  @ApiQuery({ name: 'dim', required: false, enum: ['persona', 'plan', 'scene'], description: '下钻维度，默认 plan' })
  @ApiQuery({ name: 'from', required: false, description: '起始时间 ISO 字符串，默认 30 天前' })
  @ApiQuery({ name: 'to', required: false, description: '结束时间 ISO 字符串，默认当前' })
  breakdown(
    @Query('dim') dim = 'plan',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const d = dim === 'persona' || dim === 'plan' || dim === 'scene' ? dim : 'plan'
    const range = parseRange(from, to)
    return this.analytics.getBreakdown(range.from, range.to, d)
  }

  // ── 跨租户调用链路（平台超管排查缺陷用，数据按租户隔离存储但超管可查看）──

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('traces')
  @ApiOperation({
    summary: '跨租户调用链路列表',
    description: '平台超管排查缺陷用，可跨租户查询，支持按租户/套餐/功能/状态过滤与分页。',
  })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数（1-100，默认 20）' })
  @ApiQuery({ name: 'tenantId', required: false, description: '按租户过滤' })
  @ApiQuery({ name: 'plan', required: false, description: '按套餐过滤' })
  @ApiQuery({ name: 'feature', required: false, description: '按功能过滤（contract_review/knowledge/agent 等）' })
  @ApiQuery({ name: 'status', required: false, description: '按状态过滤（success/error 等）' })
  traces(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('tenantId') tenantId?: string,
    @Query('plan') plan?: string,
    @Query('feature') feature?: string,
    @Query('status') status?: string,
  ) {
    return this.monitor.listAllTraces({
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(100, Math.max(1, Number(pageSize) || 20)),
      tenantId,
      plan,
      feature,
      status,
    })
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('traces/:id')
  @ApiOperation({ summary: '跨租户调用链路详情（瀑布）', description: '查看任意租户的 Trace 详情，含全部 spans 与 Input/Output/Metadata。' })
  @ApiParam({ name: 'id', description: 'Trace ID' })
  async traceDetail(@Param('id') id: string) {
    const detail = await this.monitor.getTraceDetailById(id)
    if (!detail) throw new NotFoundException('链路不存在')
    return detail
  }
}

/** 解析时间范围：默认近 30 天 */
function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const now = new Date()
  const end = to ? new Date(to) : now
  const start = from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 3600 * 1000)
  if (start > end) throw new Error('起始时间不能晚于结束时间')
  return { from: start, to: end }
}
