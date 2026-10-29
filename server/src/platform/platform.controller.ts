// server/src/platform/platform.controller.ts
// 平台超管接口（/api/platform）：全部 @Roles('PLATFORM_ADMIN')，登录端点除外
import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Req, Query, NotFoundException } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags, type SchemaObject } from '@nestjs/swagger'
import type { Request } from 'express'
import { PlatformService } from './platform.service.js'
import { RuleAdminService, type RuleInput, type RuleListQuery } from './rule-admin.service.js'
import { OrdersService } from '../billing/orders.service.js'
import { MonitorService } from '../monitor/monitor.service.js'
import { BillingService } from '../monitor/billing.service.js'
import { AnalyticsService } from '../analytics/analytics.service.js'
import { DatabaseService } from '../database/database.service.js'
import { Roles } from '../auth/decorators/roles.decorator.js'
import { Public } from '../auth/decorators/public.decorator.js'
import { logger } from '../utils/logger.js'

/** 平台审查规则入参（对应 RuleAdminService.RuleInput，interface 无法运行时反射，显式声明 schema） */
const ruleInputSchema: SchemaObject = {
  type: 'object',
  properties: {
    code: { type: 'string', description: '规则编码（唯一，新增时必填，如 labor_probation_over_limit）' },
    name: { type: 'string', description: '规则名称' },
    severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'], description: '风险等级' },
    category: { type: 'string', description: '风险分类' },
    scope: { type: 'string', enum: ['ALL', 'LABOR', 'INTERNSHIP'], description: '生效域：ALL 全场景 / LABOR 劳动关系 / INTERNSHIP 实习' },
    pattern: { type: 'string', nullable: true, description: '匹配正则（可空）' },
    keywords: { type: 'array', items: { type: 'string' }, description: '关键词列表' },
    prompt: { type: 'string', description: 'Agent 轨判定提示词' },
    suggestion: { type: 'string', nullable: true, description: '修改建议' },
    legalBasis: { type: 'string', nullable: true, description: '法律依据条文' },
    description: { type: 'string', nullable: true, description: '规则说明' },
    enabled: { type: 'boolean', description: '是否启用' },
    sortOrder: { type: 'integer', description: '排序权重' },
  },
}

@ApiTags('platform')
@Controller('api/platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    private readonly orders: OrdersService,
    private readonly monitor: MonitorService,
    private readonly analytics: AnalyticsService,
    private readonly rules: RuleAdminService,
    private readonly billing: BillingService,
    private readonly db: DatabaseService,
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
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  login(@Body() body: { username?: string; password?: string }) {
    return this.platform.login(body.username || '', body.password || '')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('overview')
  @ApiOperation({ summary: '运营总览', description: '平台运营总览数据（租户数、关键增长与用量指标）。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  overview() {
    return this.platform.overview()
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('tenants')
  @ApiOperation({ summary: '全量租户列表', description: '返回平台全部租户及其套餐、订阅到期时间、状态等。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  setTenantStatus(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.platform.setTenantStatus(id, body?.status || '')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('tenants/:id/users')
  @ApiOperation({ summary: '租户成员管理：成员列表', description: '查看指定租户的全部成员。' })
  @ApiParam({ name: 'id', description: '租户 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  resetPassword(@Param('id') id: string, @Param('userId') userId: string) {
    return this.platform.resetTenantUserPassword(id, userId)
  }

  // ── 转账订单人工确认 ──────────────────────────────────────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('transfer-orders')
  @ApiOperation({ summary: '转账订单列表', description: '按状态筛选转账订单，默认 PENDING。' })
  @ApiQuery({ name: 'status', required: false, enum: ['PENDING', 'CONFIRMED', 'REJECTED'], description: '订单状态，默认 PENDING' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  listTransferOrders(@Query('status') status?: string) {
    return this.orders.listTransferOrders(status || 'PENDING')
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('transfer-orders/:id/confirm')
  @ApiOperation({ summary: '确认转账到账', description: '确认后为租户开通对应套餐（续费自原到期日顺延）；重复确认同一单号返回 409。' })
  @ApiParam({ name: 'id', description: '转账订单 ID' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
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
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async traceDetail(@Param('id') id: string) {
    const detail = await this.monitor.getTraceDetailById(id)
    if (!detail) throw new NotFoundException('链路不存在')
    return detail
  }

  // ── 全局审查规则（review_rules 对所有租户生效，仅平台超管可改）──────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('rules')
  @ApiOperation({
    summary: '平台审查规则列表',
    description: '平台级声明式审查规则（scope=ALL/LABOR/INTERNSHIP 三域），所有租户的每次审查都会执行，支持关键词/启停过滤与分页。',
  })
  @ApiQuery({ name: 'q', required: false, description: '按规则编码/名称/分类关键词搜索' })
  @ApiQuery({ name: 'scope', required: false, enum: ['ALL', 'LABOR', 'INTERNSHIP'], description: '按生效域过滤' })
  @ApiQuery({ name: 'enabled', required: false, enum: ['true', 'false'], description: '按启停状态过滤' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 50' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  listRules(
    @Query('q') q?: string,
    @Query('scope') scope?: string,
    @Query('enabled') enabled?: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ) {
    const query: RuleListQuery = { q, scope, enabled, page: Number(page), pageSize: Number(pageSize) }
    return this.rules.list(query)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('rules/try')
  @ApiOperation({
    summary: '规则试跑（不落库）',
    description: '用已有规则（id）或临时规则体（rule）对给定文本试跑；labor/internship 控制劳动域规则是否生效（实习场景强制短路劳动规则）。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '已存在规则 ID（与 rule 二选一）' },
        rule: { ...ruleInputSchema, description: '临时规则体（与 id 二选一）' },
        text: { type: 'string', description: '待试跑的条款/合同文本' },
        labor: { type: 'boolean', description: '是否按劳动关系场景执行劳动域规则' },
        internship: { type: 'boolean', description: '是否实习协议场景（true 时短路 LABOR 域）' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  tryRule(@Body() body: { id?: string; rule?: RuleInput; text?: string; labor?: boolean; internship?: boolean }) {
    return this.rules.tryRule(body)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('rules/:id')
  @ApiOperation({ summary: '平台审查规则详情' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getRule(@Param('id') id: string) {
    return this.rules.get(id)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Post('rules')
  @ApiOperation({ summary: '新建平台审查规则（全平台立即生效）' })
  @ApiBody({ schema: ruleInputSchema })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  createRule(@Body() body: RuleInput) {
    logger.info('platform: review rule created', { code: body.code })
    return this.rules.create(body)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Put('rules/:id')
  @ApiOperation({ summary: '更新平台审查规则（全平台立即生效）' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiBody({ schema: ruleInputSchema })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  updateRule(@Param('id') id: string, @Body() body: RuleInput) {
    logger.info('platform: review rule updated', { id, fields: Object.keys(body) })
    return this.rules.update(id, body)
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Delete('rules/:id')
  @ApiOperation({ summary: '删除平台审查规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  deleteRule(@Param('id') id: string) {
    logger.info('platform: review rule deleted', { id })
    return this.rules.remove(id)
  }

  // ── 离线评测（EvalRun 为平台基线数据，无租户维度）────────────────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('eval-runs')
  @ApiOperation({ summary: '离线评测记录列表', description: 'EvalRun 为平台基线数据（无租户维度），分页返回。' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 20' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  listEvalRuns(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    const skip = (Number(page) - 1) * Number(pageSize)
    const take = Number(pageSize)

    return Promise.all([
      this.db.evalRun.findMany({ orderBy: { startedAt: 'desc' }, skip, take }),
      this.db.evalRun.count(),
    ]).then(([runs, total]) => ({
      total,
      page: Number(page),
      pageSize: Number(pageSize),
      items: runs.map((r) => ({
        id: r.id,
        status: r.status,
        caseCount: r.caseCount,
        passCount: r.passCount,
        commitSha: r.commitSha,
        summary: r.summary,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
      })),
    }))
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('eval-runs/:id')
  @ApiOperation({ summary: '评测记录详情', description: '含评测汇总与逐 case 结果（是否通过、得分、实际输出、评审理由、耗时）。' })
  @ApiParam({ name: 'id', description: '评测运行 ID（EvalRun id）' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async getEvalRun(@Param('id') id: string) {
    const run = await this.db.evalRun.findUnique({ where: { id } })
    if (!run) throw new ForbiddenException('评测记录不存在')

    const results = await this.db.evalResult.findMany({
      where: { runId: id },
      orderBy: [{ passed: 'asc' }, { caseId: 'asc' }],
      include: {
        case: { select: { id: true, type: true, title: true, tags: true, expected: true } },
      },
    })

    return {
      run: {
        id: run.id,
        status: run.status,
        caseCount: run.caseCount,
        passCount: run.passCount,
        commitSha: run.commitSha,
        summary: run.summary,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
      },
      results: results.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        passed: r.passed,
        score: r.score,
        actual: r.actual,
        judgeReason: r.judgeReason,
        latencyMs: r.latencyMs,
        case: r.case,
      })),
    }
  }

  // ── 租户配额账单（平台视角：全租户汇总 + 指定租户完整账单）──────────────

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('billing/tenants')
  @ApiOperation({ summary: '全租户当前账期汇总', description: '平台账单总览：各租户当前账期 token 用量与费用汇总（按费用倒序）。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  listTenantBilling() {
    return this.billing.listTenantBilling()
  }

  @Roles('PLATFORM_ADMIN')
  @ApiBearerAuth('platform')
  @Get('billing/tenants/:tenantId')
  @ApiOperation({ summary: '指定租户完整账单', description: '含峰谷计价、功能占比、历史账期与超额记录。' })
  @ApiParam({ name: 'tenantId', description: '租户 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getTenantBilling(@Param('tenantId') tenantId: string) {
    return this.billing.getBilling(tenantId)
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
