// server/src/admin/admin.controller.ts
// 管理后台：租户内用户管理、离线评测、配额账单、审查规则配置
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger'
import type { Request } from 'express'
import * as bcrypt from 'bcryptjs'
import { DatabaseService } from '../database/database.service'
import { Roles } from '../auth/decorators/roles.decorator'
import { BillingService } from '../monitor/billing.service.js'
import { RuleAdminService, type RuleInput, type RuleListQuery } from './rule-admin.service.js'
import { logger } from '../utils/logger.js'

const USER_ROLES = ['ADMIN', 'MANAGER', 'USER', 'READONLY'] as const

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

@ApiTags('admin')
@ApiBearerAuth('bearer')
@Controller('api/admin')
@Roles('ADMIN')
export class AdminController {
  constructor(
    private db: DatabaseService,
    private billing: BillingService,
    private rules: RuleAdminService,
  ) {}

  // ── 用户管理（限本租户）────────────────────────────────────────
  @Get('users')
  @ApiOperation({ summary: '用户列表（本租户，分页）', description: '仅返回当前租户成员；支持用户名/邮箱模糊搜索。' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 20' })
  @ApiQuery({ name: 'q', required: false, description: '用户名或邮箱模糊搜索' })
  async listUsers(
    @Req() req: Request,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('q') q?: string,
  ) {
    const tenantId = (req as any).user.tenantId
    const skip = (Number(page) - 1) * Number(pageSize)
    const take = Number(pageSize)
    const search = (q || '').trim()

    const [users, total] = await Promise.all([
      this.db.user.findMany({
        where: {
          tenantId,
          ...(search && {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }),
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, username: true, email: true, role: true, status: true,
          createdAt: true, lastLoginAt: true,
        },
      }),
      this.db.user.count({
        where: {
          tenantId,
          ...(search && {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }),
        },
      }),
    ])

    return { users, total, page: Number(page), pageSize: Number(pageSize) }
  }

  /** 新增本租户用户（管理员代创建，含初始密码） */
  @Post('users')
  @ApiOperation({
    summary: '新增本租户用户',
    description: '管理员代创建账号并设置初始密码。用户名 3-50 位字母/数字/下划线/中划线；密码至少 8 位；用户名/邮箱重复返回 409。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_-]{3,50}$' },
        email: { type: 'string', format: 'email', description: '邮箱（可选）' },
        password: { type: 'string', minLength: 8, description: '初始密码' },
        displayName: { type: 'string', description: '显示名，缺省同用户名' },
        role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'USER', 'READONLY'], description: '角色，默认 USER', default: 'USER' },
      },
    },
  })
  async createUser(@Req() req: Request, @Body() body: {
    username?: string; email?: string; password?: string; displayName?: string; role?: string
  }) {
    const tenantId = (req as any).user.tenantId
    const username = (body.username || '').trim()
    const email = (body.email || '').trim() || null
    const password = body.password || ''
    const displayName = (body.displayName || '').trim() || username
    const role = body.role || 'USER'

    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(username)) {
      throw new BadRequestException('用户名需 3-50 位字母/数字/下划线/中划线')
    }
    if (password.length < 8) throw new BadRequestException('初始密码至少 8 位')
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('邮箱格式不正确')
    if (!USER_ROLES.includes(role as any)) throw new BadRequestException('角色不合法')

    const dup = await this.db.user.findFirst({
      where: { OR: [{ username }, ...(email ? [{ email }] : [])] },
      select: { username: true, email: true },
    })
    if (dup?.username === username) throw new ConflictException('用户名已被占用')
    if (dup && email && dup.email === email) throw new ConflictException('该邮箱已注册')

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await this.db.user.create({
      data: {
        username, email, passwordHash, displayName,
        role: role as any, tenantId, emailVerified: Boolean(email),
      },
      select: { id: true, username: true, email: true, displayName: true, role: true, status: true, createdAt: true },
    })
    logger.info('admin: user created', { id: user.id, username, role })
    return { user }
  }

  @Put('users/:id')
  @ApiOperation({
    summary: '修改用户角色/状态',
    description: '仅可操作本租户用户（跨租户 403）。不能修改自己的角色或状态；role 取值 ADMIN/MANAGER/USER/READONLY，status 取值 ACTIVE/DISABLED。',
  })
  @ApiParam({ name: 'id', description: '目标用户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'USER', 'READONLY'] },
        status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
      },
    },
  })
  async updateUser(@Req() req: Request, @Param('id') id: string, @Body() body: any) {
    const tenantId = (req as any).user.tenantId
    const selfId = (req as any).user.userId
    const target = await this.db.user.findUnique({ where: { id }, select: { tenantId: true } })
    if (!target || target.tenantId !== tenantId) throw new ForbiddenException('无权操作该用户')
    // 防自锁：不允许修改自己的角色/状态（降级或禁用自己会导致失去管理入口）
    if (id === selfId && (body.role !== undefined || body.status !== undefined)) {
      throw new BadRequestException('不能修改自己的角色或状态，请由其他管理员操作')
    }

    const { role, status } = body
    if (role !== undefined && !USER_ROLES.includes(role)) throw new BadRequestException('角色不合法')
    if (status !== undefined && !['ACTIVE', 'DISABLED'].includes(status)) throw new BadRequestException('状态不合法')
    const user = await this.db.user.update({
      where: { id },
      data: {
        ...(role && { role }),
        ...(status !== undefined && { status }),
      },
    })

    logger.info('admin: user updated', { id, role, status })
    return { success: true, user }
  }

  @Delete('users/:id')
  @ApiOperation({ summary: '禁用用户（软删除）', description: '将目标用户置为 DISABLED，不物理删除以保留审计关联；不能禁用自己；跨租户返回 403。' })
  @ApiParam({ name: 'id', description: '目标用户 ID' })
  async deleteUser(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const selfId = (req as any).user.userId
    const target = await this.db.user.findUnique({ where: { id }, select: { tenantId: true } })
    if (!target || target.tenantId !== tenantId) throw new ForbiddenException('无权操作该用户')
    if (id === selfId) throw new BadRequestException('不能禁用自己的账号')

    // 软删除：禁用而非物理删除（保留审计关联）
    await this.db.user.update({ where: { id }, data: { status: 'DISABLED' } })
    logger.info('admin: user disabled', { id })
    return { success: true }
  }

  // ── 离线评测（EvalRun 为平台基线数据，无租户维度，ADMIN 可查）──────
  @Get('eval-runs')
  @ApiOperation({ summary: '离线评测记录列表', description: 'EvalRun 为平台基线数据（无租户维度），本租户 ADMIN 可分页查看。' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 20' })
  async listEvalRuns(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    const skip = (Number(page) - 1) * Number(pageSize)
    const take = Number(pageSize)

    const [runs, total] = await Promise.all([
      this.db.evalRun.findMany({
        orderBy: { startedAt: 'desc' },
        skip,
        take,
      }),
      this.db.evalRun.count(),
    ])

    return {
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
    }
  }

  @Get('eval-runs/:id')
  @ApiOperation({ summary: '评测记录详情', description: '含评测汇总与逐 case 结果（是否通过、得分、实际输出、评审理由、耗时）。' })
  @ApiParam({ name: 'id', description: '评测运行 ID（EvalRun id）' })
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

  // ── 配额账单：全租户当前账期汇总（费用倒序）──────────────────────
  @Get('billing/tenants')
  @ApiOperation({ summary: '全租户当前账期汇总', description: '管理后台账单总览：各租户当前账期费用汇总（按费用倒序）。' })
  listTenantBilling() {
    return this.billing.listTenantBilling()
  }

  // ── 配额账单：指定租户完整账单（峰谷/功能占比/历史账期）────────────
  @Get('billing/tenants/:tenantId')
  @ApiOperation({ summary: '指定租户完整账单', description: '含峰谷计价、功能占比、历史账期与超额记录。' })
  @ApiParam({ name: 'tenantId', description: '租户 ID' })
  getTenantBilling(@Param('tenantId') tenantId: string) {
    return this.billing.getBilling(tenantId)
  }

  // ── 审查规则管理（平台级配置，无租户维度）────────────────────────
  @Get('rules')
  @ApiOperation({
    summary: '平台审查规则列表',
    description: '平台级 16+ 条声明式审查规则（scope=ALL/LABOR/INTERNSHIP 三域），支持关键词/启停过滤与分页。',
  })
  @ApiQuery({ name: 'q', required: false, description: '按规则编码/名称/分类关键词搜索' })
  @ApiQuery({ name: 'scope', required: false, enum: ['ALL', 'LABOR', 'INTERNSHIP'], description: '按生效域过滤' })
  @ApiQuery({ name: 'enabled', required: false, enum: ['true', 'false'], description: '按启停状态过滤' })
  @ApiQuery({ name: 'page', required: false, description: '页码，默认 1' })
  @ApiQuery({ name: 'pageSize', required: false, description: '每页条数，默认 50' })
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

  // 注意：须放在 GET rules/:id 之前注册，避免 'try' 被当成 :id（POST 方法本身不与 GET :id 冲突，保持显式）
  @Post('rules/try')
  @ApiOperation({
    summary: '规则试跑（规则管理后台）',
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
  tryRule(@Body() body: { id?: string; rule?: RuleInput; text?: string; labor?: boolean; internship?: boolean }) {
    return this.rules.tryRule(body)
  }

  @Get('rules/:id')
  @ApiOperation({ summary: '规则详情' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  getRule(@Param('id') id: string) {
    return this.rules.get(id)
  }

  @Post('rules')
  @ApiOperation({ summary: '新建平台审查规则' })
  @ApiBody({ schema: ruleInputSchema })
  createRule(@Body() body: RuleInput) {
    logger.info('admin: review rule created', { code: body.code })
    return this.rules.create(body)
  }

  @Put('rules/:id')
  @ApiOperation({ summary: '更新平台审查规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiBody({ schema: ruleInputSchema })
  updateRule(@Param('id') id: string, @Body() body: RuleInput) {
    logger.info('admin: review rule updated', { id, fields: Object.keys(body) })
    return this.rules.update(id, body)
  }

  @Delete('rules/:id')
  @ApiOperation({ summary: '删除平台审查规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  deleteRule(@Param('id') id: string) {
    return this.rules.remove(id)
  }
}
