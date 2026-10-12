// server/src/platform/platform.service.ts
// 平台级超级管理员服务：启动种子账号、平台登录校验、跨租户管理
import { Injectable, OnModuleInit, UnauthorizedException, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { DatabaseService } from '../database/database.service.js'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'

const TENANT_PLANS = ['FREE', 'PERSONAL', 'TEAM', 'ENTERPRISE'] as const
const USER_ROLES = ['ADMIN', 'MANAGER', 'USER', 'READONLY'] as const

@Injectable()
export class PlatformService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  /** 启动种子：确保平台超管账号存在（仅创建，不改已有账号密码） */
  async onModuleInit() {
    try {
      const { username, password } = config.platformAdmin
      const existing = await this.db.platformAdmin.findUnique({ where: { username } })
      if (!existing) {
        await this.db.platformAdmin.create({
          data: { username, passwordHash: await bcrypt.hash(password, 12) },
        })
        logger.info(`platform admin seeded: ${username}`)
      }
    } catch (err) {
      logger.error(`platform admin seed failed: ${(err as Error).message}`)
    }
  }

  /** 平台超管登录：独立账号体系，签发 type=platform 的 JWT（无租户上下文） */
  async login(username: string, password: string) {
    const admin = await this.db.platformAdmin.findUnique({ where: { username: (username || '').trim() } })
    if (!admin) throw new UnauthorizedException('账号或密码错误')
    const ok = await bcrypt.compare(password || '', admin.passwordHash)
    if (!ok) throw new UnauthorizedException('账号或密码错误')
    await this.db.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } })
    const accessToken = await this.jwt.signAsync({
      sub: admin.id,
      username: admin.username,
      role: 'PLATFORM_ADMIN',
      type: 'platform',
    })
    return { accessToken, username: admin.username }
  }

  // ── 租户管理 ──────────────────────────────────────────────────

  /** 全部租户列表：套餐 / 状态 / 成员数 / 本月 token 用量 */
  async listTenants() {
    const tenants = await this.db.tenant.findMany({ orderBy: { createdAt: 'desc' } })
    const period = new Date().toISOString().slice(0, 7)
    const usage = await this.db.quotaUsage.findMany({ where: { period } })
    const usageMap = new Map(usage.map((u) => [u.tenantId, u]))
    const counts = await this.db.user.groupBy({ by: ['tenantId'], _count: { _all: true } })
    const countMap = new Map(counts.map((c) => [c.tenantId, c._count._all]))

    return {
      tenants: tenants.map((t) => ({
        id: t.id,
        name: t.name,
        plan: t.plan,
        workspaceType: t.workspaceType,
        status: t.status,
        couponBalance: t.couponBalance,
        monthlyTokenQuota: t.monthlyTokenQuota,
        planExpiresAt: t.planExpiresAt?.toISOString() ?? null,
        cancelAtPeriodEnd: t.cancelAtPeriodEnd,
        createdAt: t.createdAt.toISOString(),
        userCount: countMap.get(t.id) ?? 0,
        tokensUsed:
          (usageMap.get(t.id)?.inputTokens ?? 0) + (usageMap.get(t.id)?.outputTokens ?? 0),
      })),
    }
  }

  /** 修改租户套餐与订阅期 */
  async updateTenantPlan(tenantId: string, body: { plan?: string; planExpiresAt?: string | null }) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('租户不存在')
    const plan = body.plan
    if (plan !== undefined) {
      if (!TENANT_PLANS.includes(plan as any)) throw new BadRequestException('套餐不合法')
    }
    let expiresAt: Date | null | undefined
    if (body.planExpiresAt !== undefined) {
      if (body.planExpiresAt === null || body.planExpiresAt === '') expiresAt = null
      else {
        expiresAt = new Date(body.planExpiresAt)
        if (Number.isNaN(expiresAt.getTime())) throw new BadRequestException('到期时间格式不正确')
      }
    }
    const updated = await this.db.tenant.update({
      where: { id: tenantId },
      data: {
        ...(plan !== undefined && { plan: plan as any, planUpdatedAt: new Date() }),
        ...(expiresAt !== undefined && { planExpiresAt: expiresAt }),
        ...(plan !== undefined && plan !== 'FREE' && { cancelAtPeriodEnd: false }),
      },
    })
    logger.info('platform: tenant plan updated', { tenantId, plan, planExpiresAt: body.planExpiresAt })
    return { success: true, plan: updated.plan, planExpiresAt: updated.planExpiresAt?.toISOString() ?? null }
  }

  /** 启用/禁用整个租户（DISABLED 后该租户所有用户无法登录） */
  async setTenantStatus(tenantId: string, status: string) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new BadRequestException('状态不合法')
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('租户不存在')
    await this.db.tenant.update({ where: { id: tenantId }, data: { status: status as any } })
    logger.info('platform: tenant status updated', { tenantId, status })
    return { success: true }
  }

  // ── 跨租户成员管理 ────────────────────────────────────────────

  /** 指定租户成员列表 */
  async listTenantUsers(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('租户不存在')
    const users = await this.db.user.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, username: true, email: true, displayName: true, role: true,
        status: true, lastLoginAt: true, createdAt: true,
      },
    })
    return { tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan }, users }
  }

  /** 跨租户改成员角色/状态 */
  async updateTenantUser(tenantId: string, userId: string, body: { role?: string; status?: string }) {
    const target = await this.db.user.findUnique({ where: { id: userId } })
    if (!target || target.tenantId !== tenantId) throw new NotFoundException('用户不存在')
    if (body.role !== undefined && !USER_ROLES.includes(body.role as any)) throw new BadRequestException('角色不合法')
    if (body.status !== undefined && !['ACTIVE', 'DISABLED'].includes(body.status)) throw new BadRequestException('状态不合法')
    await this.db.user.update({
      where: { id: userId },
      data: {
        ...(body.role !== undefined && { role: body.role as any }),
        ...(body.status !== undefined && { status: body.status as any }),
      },
    })
    logger.info('platform: tenant user updated', { tenantId, userId, ...body })
    return { success: true }
  }

  /** 跨租户重置成员密码：生成随机临时密码返回（仅此一次展示） */
  async resetTenantUserPassword(tenantId: string, userId: string) {
    const target = await this.db.user.findUnique({ where: { id: userId } })
    if (!target || target.tenantId !== tenantId) throw new NotFoundException('用户不存在')
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
    let temp = ''
    for (let i = 0; i < 12; i++) temp += alphabet[Math.floor(Math.random() * alphabet.length)]
    await this.db.user.update({
      where: { id: userId },
      data: { passwordHash: await bcrypt.hash(temp, 12) },
    })
    logger.info('platform: tenant user password reset', { tenantId, userId })
    return { success: true, temporaryPassword: temp }
  }

  /** 平台运营总览（控制台顶部统计卡） */
  async overview() {
    const [tenantCount, activeTenants, userCount, byPlan] = await Promise.all([
      this.db.tenant.count(),
      this.db.tenant.count({ where: { status: 'ACTIVE' } }),
      this.db.user.count(),
      this.db.tenant.groupBy({ by: ['plan'], _count: { _all: true } }),
    ])
    return {
      tenantCount,
      activeTenants,
      disabledTenants: tenantCount - activeTenants,
      userCount,
      planDistribution: Object.fromEntries(byPlan.map((p) => [p.plan, p._count._all])),
    }
  }

  /** 新建租户（平台侧代开企业空间） */
  async createTenant(body: { name?: string; plan?: string; adminUsername?: string; adminPassword?: string }) {
    const name = (body.name || '').trim()
    const plan = body.plan || 'ENTERPRISE'
    const adminUsername = (body.adminUsername || '').trim()
    const adminPassword = body.adminPassword || ''
    if (!name) throw new BadRequestException('请填写企业名称')
    if (!TENANT_PLANS.includes(plan as any)) throw new BadRequestException('套餐不合法')
    if (!/^[a-zA-Z0-9_-]{3,50}$/.test(adminUsername)) throw new BadRequestException('管理员用户名需 3-50 位字母/数字/下划线/中划线')
    if (adminPassword.length < 8) throw new BadRequestException('管理员初始密码至少 8 位')
    const dup = await this.db.user.findUnique({ where: { username: adminUsername }, select: { id: true } })
    if (dup) throw new ConflictException('管理员用户名已被占用')

    const created = await this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name,
          plan: plan as any,
          workspaceType: 'TEAM',
          status: 'ACTIVE',
          planUpdatedAt: new Date(),
          // 付费套餐默认订阅期 1 年，可随时在控制台调整
          planExpiresAt: plan === 'FREE' ? null : new Date(Date.now() + 365 * 86400_000),
        },
      })
      await tx.user.create({
        data: {
          username: adminUsername,
          passwordHash: await bcrypt.hash(adminPassword, 12),
          displayName: name,
          role: 'ADMIN',
          tenantId: tenant.id,
        },
      })
      return tenant
    })
    logger.info('platform: tenant created', { tenantId: created.id, name, plan })
    return { success: true, tenantId: created.id }
  }
}
