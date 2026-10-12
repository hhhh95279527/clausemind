// server/src/admin/admin.controller.ts
// 管理后台：租户内用户管理、系统配置、基于 Trace 的用量聚合
import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Param, Post, Put, Query, Req } from '@nestjs/common'
import type { Request } from 'express'
import * as bcrypt from 'bcryptjs'
import { DatabaseService } from '../database/database.service'
import { Roles } from '../auth/decorators/roles.decorator'
import { BillingService } from '../monitor/billing.service.js'
import { RuleAdminService, type RuleInput, type RuleListQuery } from './rule-admin.service.js'
import { logger } from '../utils/logger.js'

const USER_ROLES = ['ADMIN', 'MANAGER', 'USER', 'READONLY'] as const

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

  // ── 系统配置 ──────────────────────────────────────────────────
  @Get('config')
  async getConfig() {
    const configs = await this.db.systemConfig.findMany()
    const configMap: Record<string, any> = {}
    configs.forEach((c) => { configMap[c.key] = c.value })
    return { config: configMap }
  }

  @Put('config')
  async updateConfig(@Body() body: Record<string, any>) {
    await Promise.all(
      Object.entries(body).map(([key, value]) =>
        this.db.systemConfig.upsert({
          where: { key },
          update: { value: value as any },
          create: { key, value: value as any },
        }),
      ),
    )
    logger.info('admin: config updated', { keys: Object.keys(body) })
    return { success: true }
  }

  // ── 用量统计（从 Trace 聚合，近 N 天）──────────────────────────
  @Get('usage')
  async getUsage(@Req() req: Request, @Query('days') days = '30') {
    const tenantId = (req as any).user.tenantId
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - Number(days))

    // 按天聚合：Prisma 不支持 date_trunc，用原生 SQL
    const daily = await this.db.$queryRaw<any[]>`
      SELECT date_trunc('day', created_at)::date AS date,
             COUNT(*)::int                          AS calls,
             COALESCE(SUM(input_tokens + output_tokens), 0)::bigint AS tokens,
             COALESCE(SUM(cost_cny), 0)::float       AS cost
      FROM traces
      WHERE tenant_id = ${tenantId} AND created_at >= ${startDate}
      GROUP BY 1 ORDER BY 1`

    const byFeature = await this.db.trace.groupBy({
      by: ['feature'],
      where: { tenantId, createdAt: { gte: startDate } },
      _sum: { inputTokens: true, outputTokens: true, costCny: true },
      _count: { _all: true },
    })

    const total = await this.db.trace.aggregate({
      where: { tenantId, createdAt: { gte: startDate } },
      _sum: { inputTokens: true, outputTokens: true, costCny: true },
      _count: { _all: true },
    })

    return {
      daily: daily.map((d) => ({
        date: d.date,
        calls: d.calls,
        tokens: Number(d.tokens),
        costCny: Number(d.cost),
      })),
      byFeature: byFeature.map((f) => ({
        feature: f.feature,
        calls: f._count._all,
        tokens: (f._sum.inputTokens || 0) + (f._sum.outputTokens || 0),
        costCny: Number(f._sum.costCny || 0),
      })),
      total: {
        calls: total._count._all,
        tokens: (total._sum.inputTokens || 0) + (total._sum.outputTokens || 0),
        costCny: Number(total._sum.costCny || 0),
      },
    }
  }

  // ── 离线评测（EvalRun 为平台基线数据，无租户维度，ADMIN 可查）──────
  @Get('eval-runs')
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

  // ── 成员用量排行 ──────────────────────────────────────────────
  @Get('usage/users')
  async getUserUsage(@Req() req: Request, @Query('days') days = '30') {
    const tenantId = (req as any).user.tenantId
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - Number(days))

    const usage = await this.db.trace.groupBy({
      by: ['userId'],
      where: { tenantId, createdAt: { gte: startDate }, userId: { not: null } },
      _sum: { inputTokens: true, outputTokens: true },
      _count: { _all: true },
      orderBy: { _sum: { outputTokens: 'desc' } },
      take: 50,
    })

    const userIds = usage.map((u) => u.userId!).filter(Boolean)
    const users = await this.db.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, username: true, email: true },
    })
    const userMap = Object.fromEntries(users.map((u) => [u.id, u]))

    return {
      users: usage.map((u) => ({
        userId: u.userId,
        username: userMap[u.userId!]?.username || 'Unknown',
        email: userMap[u.userId!]?.email || '',
        calls: u._count._all,
        tokens: (u._sum.inputTokens || 0) + (u._sum.outputTokens || 0),
      })),
    }
  }

  // ── 配额账单：全租户当前账期汇总（费用倒序）──────────────────────
  @Get('billing/tenants')
  listTenantBilling() {
    return this.billing.listTenantBilling()
  }

  // ── 配额账单：指定租户完整账单（峰谷/功能占比/历史账期）────────────
  @Get('billing/tenants/:tenantId')
  getTenantBilling(@Param('tenantId') tenantId: string) {
    return this.billing.getBilling(tenantId)
  }

  // ── 审查规则管理（平台级配置，无租户维度）────────────────────────
  @Get('rules')
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
  tryRule(@Body() body: { id?: string; rule?: RuleInput; text?: string; labor?: boolean; internship?: boolean }) {
    return this.rules.tryRule(body)
  }

  @Get('rules/:id')
  getRule(@Param('id') id: string) {
    return this.rules.get(id)
  }

  @Post('rules')
  createRule(@Body() body: RuleInput) {
    logger.info('admin: review rule created', { code: body.code })
    return this.rules.create(body)
  }

  @Put('rules/:id')
  updateRule(@Param('id') id: string, @Body() body: RuleInput) {
    logger.info('admin: review rule updated', { id, fields: Object.keys(body) })
    return this.rules.update(id, body)
  }

  @Delete('rules/:id')
  deleteRule(@Param('id') id: string) {
    return this.rules.remove(id)
  }
}
