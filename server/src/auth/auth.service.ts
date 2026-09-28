// server/src/auth/auth.service.ts
// 认证服务：注册（个人/企业分流）、密码登录、邮箱验证码登录、Token 刷新、密码管理
import { Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { DatabaseService } from '../database/database.service'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import type { UserRole, WorkspaceType, TenantPlan } from '@prisma/client'
import { VerificationCodeService } from './verification-code.service.js'

export type RegisterPersona = 'PERSONAL' | 'TEAM'

interface RegisterDto {
  persona: RegisterPersona
  email: string
  emailCode: string
  password: string
  displayName?: string
  // 企业流
  orgName?: string
  companySize?: string
  position?: string
}

/** 返回给前端的用户体：携带套餐与空间类型，供 persona 路由与权益展示 */
export interface AuthUserPayload {
  id: string
  username: string
  email: string | null
  displayName: string | null
  role: UserRole
  tenantId: string
  plan: TenantPlan
  workspaceType: WorkspaceType
  couponBalance: number
  onboardingCompleted: boolean
  emailVerified: boolean
}

/** 签发 refresh token 时记录的客户端信息（用于审计与异常排查） */
export interface TokenMeta {
  ip?: string
  userAgent?: string
}

/** jsonwebtoken 风格 TTL（如 30d/12h/30m）→ 秒 */
function ttlSeconds(v: string | number): number {
  if (typeof v === 'number') return v
  const m = /^(\d+)\s*([smhd])$/.exec(String(v).trim())
  if (!m) return 30 * 24 * 3600
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * mult
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly verificationCodes: VerificationCodeService,
  ) {}

  // ── 注册：个人 / 企业双路径分流（FR-3）────────────────────────
  // PERSONAL → FREE 个人空间；TEAM → TEAM 团队版演示空间（原型确认：默认含 5 席演示）
  async register(dto: RegisterDto, meta: TokenMeta = {}) {
    const email = (dto.email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确')
    }
    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException('密码至少 8 位')
    }
    if (dto.persona !== 'PERSONAL' && dto.persona !== 'TEAM') {
      throw new BadRequestException('请选择注册身份（个人 / 企业）')
    }
    if (dto.persona === 'TEAM' && !(dto.orgName || '').trim()) {
      throw new BadRequestException('请填写企业名称')
    }

    const existingEmail = await this.db.user.findUnique({ where: { email } })
    if (existingEmail) {
      throw new ConflictException('该邮箱已注册，请直接登录')
    }
    // 注册必须验证码通过（dev 控制台码 / 固定码 123456）
    await this.verificationCodes.verifyCode(email, dto.emailCode)

    const passwordHash = await bcrypt.hash(dto.password, 12)
    const displayName = (dto.displayName || '').trim() || email.split('@')[0]

    const isTeam = dto.persona === 'TEAM'
    // 租户 + 用户在一个事务里创建（UserProfile 已下线，不再创建）
    const created = await this.db.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: isTeam
          ? {
              name: dto.orgName!.trim(),
              plan: 'TEAM' as TenantPlan,
              workspaceType: 'TEAM' as WorkspaceType,
              planUpdatedAt: new Date(),
            }
          : {
              name: `${displayName} 的个人空间`,
              plan: 'FREE' as TenantPlan,
              workspaceType: 'PERSONAL' as WorkspaceType,
            },
      })

      return tx.user.create({
        data: {
          username: await this.uniqueUsername(tx, email),
          email,
          passwordHash,
          displayName,
          role: 'ADMIN' as UserRole, // 空间创建者=租户管理员（团队管理/席位需要）
          tenantId: tenant.id,
          emailVerified: true,
          metadata: isTeam
            ? { companySize: dto.companySize ?? null, position: dto.position ?? null }
            : undefined,
        },
      })
    })

    const user = await this.buildUserPayload(created.id)
    const tokens = await this.issueTokens(user, meta)
    return { user, ...tokens }
  }

  // ── 邮箱验证码登录：未注册邮箱自动开通 FREE 个人空间（FR-4）──────
  async loginByCode(email: string, code: string, meta: TokenMeta = {}) {
    const normalized = (email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException('邮箱格式不正确')
    }
    await this.verificationCodes.verifyCode(normalized, code)

    let user = await this.db.user.findUnique({ where: { email: normalized } })

    // 未注册：自动开户 FREE 个人空间（P0 直接开户，P1 强校验设置密码）
    if (!user) {
      const randomPasswordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 12)
      const created = await this.db.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: `${normalized.split('@')[0]} 的个人空间`,
            plan: 'FREE' as TenantPlan,
            workspaceType: 'PERSONAL' as WorkspaceType,
          },
        })
        return tx.user.create({
          data: {
            username: await this.uniqueUsername(tx, normalized),
            email: normalized,
            passwordHash: randomPasswordHash,
            displayName: normalized.split('@')[0],
            role: 'USER' as UserRole,
            tenantId: tenant.id,
            emailVerified: true,
          },
        })
      })
      logger.info('auth: auto signup via email code', { userId: created.id })
      user = created
    }

    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('账号已被禁用')
    }
    if (!user.emailVerified) {
      await this.db.user.update({ where: { id: user.id }, data: { emailVerified: true } })
    }
    return this.login(user, meta)
  }

  /** 由邮箱生成唯一用户名（个人流无用户名字段；username 列 VarChar(50) 唯一非空） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async uniqueUsername(tx: any, email: string): Promise<string> {
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32) || 'user'
    let candidate = base
    for (let i = 0; i < 20; i++) {
      const exists = await tx.user.findUnique({ where: { username: candidate } })
      if (!exists) return candidate
      candidate = `${base}${randomBytes(2).toString('hex')}`
    }
    return `${base}${randomBytes(4).toString('hex')}`
  }

  /** 组装前端用户体（联查租户套餐/空间类型） */
  private async buildUserPayload(userId: string): Promise<AuthUserPayload> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      include: { tenant: true },
    })
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      tenantId: user.tenantId,
      plan: user.tenant.plan,
      workspaceType: user.tenant.workspaceType,
      couponBalance: user.tenant.couponBalance,
      onboardingCompleted: user.onboardingCompleted,
      emailVerified: user.emailVerified,
    }
  }

  // ── 登录（validateUser 被 LocalStrategy 调用）────────────────
  async validateUser(username: string, password: string) {
    const user = await this.db.user.findFirst({
      where: { OR: [{ username }, { email: username }] },
    })
    if (!user) throw new UnauthorizedException('用户不存在')
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('账号已被禁用')

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('密码错误')

    const { passwordHash, ...result } = user
    return result
  }

  // ── 登录并返回 Token（user 体携带套餐/空间类型，供前端 persona 路由）──
  async login(user: any, meta: TokenMeta = {}) {
    await this.db.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), ...(meta.ip ? { lastLoginIp: meta.ip.slice(0, 45) } : {}) },
    })
    const payload = await this.buildUserPayload(user.id)
    const tokens = await this.issueTokens(
      { id: payload.id, username: payload.username, role: payload.role, tenantId: payload.tenantId },
      meta,
    )
    return { user: payload, ...tokens }
  }

  // ── 刷新 Token：一次性轮转 + 重用检测 ─────────────────────────
  async refreshToken(rawRefreshToken: string, meta: TokenMeta = {}) {
    let payload: any
    try {
      payload = this.jwtService.verify(rawRefreshToken, { secret: config.jwt.refreshSecret })
    } catch {
      throw new UnauthorizedException('Refresh Token 无效或已过期')
    }

    const stored = await this.db.refreshToken.findUnique({
      where: { tokenHash: sha256(rawRefreshToken) },
    })

    // DB 无记录：旧版无状态 token / 已被清理 / 伪造，一律拒绝并强制重新登录
    if (!stored || stored.userId !== payload.sub) {
      throw new UnauthorizedException('Refresh Token 无效或已过期')
    }

    // 收到已撤销的 refresh token = 重放或泄漏：吊销该用户全部会话
    if (stored.revokedAt) {
      await this.revokeAllUserTokens(stored.userId)
      logger.warn('auth: refresh token reuse detected, all sessions revoked', {
        userId: stored.userId, tokenId: stored.id, ip: meta.ip,
      })
      throw new UnauthorizedException('检测到异常登录，请重新登录')
    }

    if (stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Refresh Token 无效或已过期')
    }

    const user = await this.db.user.findUnique({
      where: { id: stored.userId },
      select: { id: true, username: true, email: true, displayName: true, role: true, status: true, tenantId: true },
    })
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('用户不存在或已被禁用')
    }

    // 轮转：签发新对，旧 refresh token 标记撤销并指向继任者（同一事务 + 条件抢占，杜绝并发双花）
    return this.db.$transaction(async (tx) => {
      const tokens = await this.buildTokens(
        { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId },
      )
      const newRow = await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(tokens.refreshToken),
          expiresAt: new Date(Date.now() + ttlSeconds(config.jwt.refreshExpiresIn) * 1000),
          ip: meta.ip?.slice(0, 45) || null,
          userAgent: meta.userAgent?.slice(0, 500) || null,
        },
      })
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: newRow.id },
      })
      if (claimed.count === 0) throw new UnauthorizedException('Refresh Token 已被使用，请重新登录')
      return tokens
    })
  }

  /** 吊销用户全部有效 refresh token（改密/检测到重放时调用） */
  private async revokeAllUserTokens(userId: string) {
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  // ── 获取当前用户信息（含套餐/空间类型/引导状态）────────────────
  async getProfile(userId: string) {
    try {
      return await this.buildUserPayload(userId)
    } catch {
      throw new UnauthorizedException('用户不存在')
    }
  }

  // ── 完成新手引导（3 步欢迎引导结束/跳过后持久化，FR-3）─────────
  async completeOnboarding(userId: string) {
    await this.db.user.update({
      where: { id: userId },
      data: { onboardingCompleted: true },
    })
    return this.buildUserPayload(userId)
  }

  // ── 修改密码 ─────────────────────────────────────────────────
  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.db.user.findUnique({ where: { id: userId } })
    if (!user) throw new UnauthorizedException('用户不存在')

    const valid = await bcrypt.compare(oldPassword, user.passwordHash)
    if (!valid) throw new UnauthorizedException('原密码错误')

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await this.db.user.update({
      where: { id: userId },
      data: { passwordHash },
    })
    // 改密后吊销全部既有会话，强制其他设备用新密码重新登录
    await this.revokeAllUserTokens(userId)

    return { success: true }
  }

  // ── 内部方法 ─────────────────────────────────────────────────

  /** 签发 token 对并把 refresh token（哈希）持久化 */
  private async issueTokens(
    user: { id: string; username: string; role: string; tenantId: string },
    meta: TokenMeta = {},
  ) {
    const tokens = await this.buildTokens(user)
    await this.db.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(tokens.refreshToken),
        expiresAt: new Date(Date.now() + ttlSeconds(config.jwt.refreshExpiresIn) * 1000),
        ip: meta.ip?.slice(0, 45) || null,
        userAgent: meta.userAgent?.slice(0, 500) || null,
      },
    })
    return tokens
  }

  /** 只做签名（refresh payload 带 jti；DB 行由调用方持久化/轮转） */
  private async buildTokens(user: { id: string; username: string; role: string; tenantId: string }) {
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
      jti: randomUUID(),
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload),
      this.jwtService.signAsync(payload, {
        secret: config.jwt.refreshSecret,
        expiresIn: config.jwt.refreshExpiresIn as any,
      }),
    ])

    return { accessToken, refreshToken }
  }
}
