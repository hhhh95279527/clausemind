// server/src/auth/auth.service.ts
// 认证服务：注册（个人/企业分流）、密码登录、邮箱验证码登录、Token 刷新、密码管理
import { Injectable, ConflictException, UnauthorizedException, BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcryptjs'
import { createHash, randomUUID, randomBytes } from 'node:crypto'
import { DatabaseService } from '../database/database.service'
import { RedisService } from '../redis/redis.service.js'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import type { UserRole, WorkspaceType, TenantPlan } from '@prisma/client'
import { VerificationCodeService } from './verification-code.service.js'
import { MailerService } from './mailer.service.js'

type RegisterPersona = 'PERSONAL' | 'TEAM' | 'INVITE'

/**
 * 注册请求体。三种 persona 的完整示例（示例值仅用于阅读，非业务默认值）：
 *
 * 【PERSONAL 个人版】
 * {
 *   "persona": "PERSONAL",
 *   "username": "zhangsan",
 *   "email": "ZhangSan@Example.com",
 *   "password": "Passw0rd!",
 *   "displayName": "张三"
 * }
 * → 建 FREE / PERSONAL 租户（name="张三 的个人空间"），user.role=ADMIN、status=ACTIVE
 *
 * 【TEAM 企业版】
 * {
 *   "persona": "TEAM",
 *   "username": "lisi",
 *   "email": "lisi@acme.com",
 *   "password": "Acme@2026",
 *   "displayName": "李四",
 *   "orgName": "艾克米科技有限公司",
 *   "companySize": "50-200人",
 *   "position": "HRD"
 * }
 * → 建 TEAM / TEAM 租户（planUpdatedAt=now），
 *   user.metadata={"companySize":"50-200人","position":"HRD"}
 *
 * 【INVITE 邀请加入】
 * {
 *   "persona": "INVITE",
 *   "username": "wangwu",
 *   "email": "wangwu@acme.com",
 *   "password": "Wang@2026",
 *   "inviteToken": "3f9c8a7b2d1e4f5a6b7c8d9e0f1a2b3c"
 * }
 * → 不建租户，加入邀请指向的团队；user.role=USER、status=PENDING（待审批），不签发 token
 */
export interface RegisterDto {
  /** 注册类型。示例：'TEAM'（传 'XXX' → 400 请选择注册身份） */
  persona: RegisterPersona
  /** 用户名，3-20 位字母/数字/下划线，唯一。示例：'zhangsan'（'ab'、'张三' → 400） */
  username: string
  /** 邮箱，仅格式校验；入库前 trim + 小写。示例：' ZhangSan@Example.com ' → 存 'zhangsan@example.com' */
  email: string
  /** 登录密码，至少 8 位。示例：'Passw0rd!'（'1234567' → 400 密码至少 8 位） */
  password: string
  /** 显示名称，可选；为空回退为 username。示例：'张三' */
  displayName?: string
  // 企业流
  /** 【TEAM 必填】企业/团队名称。示例：'艾克米科技有限公司' */
  orgName?: string
  /** 【TEAM 可选】团队规模 → users.metadata.companySize。示例：'50-200人' */
  companySize?: string
  /** 【TEAM 可选】职位 → users.metadata.position。示例：'HRD' */
  position?: string
  // 邀请流（persona=INVITE）：团队邀请链接 token
  /** 【INVITE 必填】tenant_invites.token（64 位 hex）。示例：'3f9c8a7b2d1e4f5a6b7c8d9e0f1a2b3c' */
  inviteToken?: string
}

/** 用户名规则：3-20 位字母、数字或下划线（登录时与邮箱二选一） */
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

/**
 * 返回给前端的用户体：携带套餐与空间类型，供 persona 路由与权益展示。
 * 示例（注册 PERSONAL 后立即返回的 user）：
 * {
 *   "id": "cm1x2y3z40000abcd1234efgh",
 *   "username": "zhangsan",
 *   "email": "zhangsan@example.com",
 *   "displayName": "张三",
 *   "role": "ADMIN",
 *   "tenantId": "cm1x2y3z40001abcd5678ijkl",
 *   "plan": "FREE",
 *   "workspaceType": "PERSONAL",
 *   "couponBalance": 0,
 *   "onboardingCompleted": false,
 *   "emailVerified": false
 * }
 */
interface AuthUserPayload {
  /** users.id（cuid）。示例：'cm1x2y3z40000abcd1234efgh' */
  id: string
  /** users.username。示例：'zhangsan' */
  username: string
  /** users.email，可为 null。示例：'zhangsan@example.com' */
  email: string | null
  /** users.display_name，可为 null。示例：'张三' */
  displayName: string | null
  /** users.role。示例：'ADMIN'（建空间者）；成员为 'USER' */
  role: UserRole
  /** users.tenant_id。示例：'cm1x2y3z40001abcd5678ijkl' */
  tenantId: string
  /** tenants.plan。示例：'FREE' | 'TEAM' | 'PERSONAL' | 'ENTERPRISE' */
  plan: TenantPlan
  /** tenants.workspace_type，前端 persona 路由主依据。示例：'PERSONAL' | 'TEAM' */
  workspaceType: WorkspaceType
  /** tenants.coupon_balance 深度券余额。示例：0 */
  couponBalance: number
  /** users.onboarding_completed。示例：false（邀请流为 true） */
  onboardingCompleted: boolean
  /** users.email_verified。示例：false（首次验证码登录后 true） */
  emailVerified: boolean
}

/**
 * 签发 refresh token 时记录的客户端信息（来自 controller 的 clientMeta(req)，不是请求体字段）。
 * 示例：{ "ip": "::ffff:192.168.1.23", "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0" }
 * 落库：refresh_tokens.ip（截 45 字符）、refresh_tokens.user_agent（截 500 字符）；
 *       登录时另写 users.last_login_ip。
 */
interface TokenMeta {
  /** 客户端 IP。示例：'::ffff:192.168.1.23' */
  ip?: string
  /** 浏览器 UA。示例：'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0' */
  userAgent?: string
}

/**
 * jsonwebtoken 风格 TTL（如 30d/12h/30m）→ 秒。
 *
 * @param v 形如 '<数字><单位>'，单位支持 s/m/h/d
 * @returns 对应秒数；无法解析时回落 2592000（30 天）
 *
 * 示例：'30d'→2592000，'12h'→43200，'30m'→1800，'45s'→45。
 */
function ttlSeconds(v: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(v.trim())
  if (!m) return 30 * 24 * 3600
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * mult
}

/**
 * 计算 refresh token 的落库哈希（64 位 hex）。
 *
 * @param s refresh JWT 明文
 * @returns sha256 十六进制摘要（64 字符），存入 refresh_tokens.token_hash
 *
 * 示例：'eyJhbGciOiJIUzI1NiIs...' → '9f2c4a7d1b8e3c5f6a0d2b4e8c1f3a5b7d9e0c2a4f6b8d1e3a5c7f9b0d2e4c6a'
 */
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/**
 * 认证服务。
 * 职责：注册分流（个人 / 企业 / 邀请）、密码登录、邮箱验证码登录、Token 签发与轮转、密码管理。
 * 边界：不做 HTTP 参数提取（见 auth.controller.ts），不实现验证码生成细节（见 verification-code.service.ts）。
 * 安全约定：密码只存 bcrypt 哈希；refresh token 只存 sha256 哈希；改密/重放会吊销该用户全部会话。
 */
@Injectable()
export class AuthService {
  /**
   * 依赖注入。五个依赖各自用途：
   * @param db                Prisma 封装（用户/租户/邀请/refresh token 的读写与事务）
   * @param jwtService        JWT 签发与验签（access 用 JWT_SECRET，refresh 用 JWT_REFRESH_SECRET）
   * @param verificationCodes 邮箱验证码的发送与校验（6 位、5 分钟、60 秒频控）
   * @param redis             Redis（忘记密码一次性 token、频控键）
   * @param mailer            邮件发送（验证码、重置链接、邀请审批通知）
   */
  constructor(
    private readonly db: DatabaseService,
    private readonly jwtService: JwtService,
    private readonly verificationCodes: VerificationCodeService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
  ) {}

  // ── 注册：个人 / 企业 / 团队邀请三路径（FR-3 + 邀请审批流）────────
  // PERSONAL → FREE 个人空间；TEAM → TEAM 团队版演示空间（默认含 5 席演示）
  // INVITE → 凭团队邀请链接加入指定租户，role=USER、status=PENDING，管理员审批通过才可登录
  // 注册不强制邮箱验证码：用户名 + 密码即可开户；邮箱归属在首次"验证码登录"时自然验证
  /**
   * 注册（三条 persona 路径分流）。
   *
   * @param dto  注册请求体（RegisterDto）：persona/username/email/password 必填，其余按 persona 选填
   * @param meta 客户端信息（ip/userAgent），用于签发 refresh token 时落库，便于审计
   * @returns 两种形状：
   *          PERSONAL / TEAM → { user: AuthUserPayload, accessToken, refreshToken }（注册即登录）
   *          INVITE         → { pending: true, tenantName: string }（不签发 token，等管理员审批）
   * @throws BadRequestException   用户名/密码/persona/企业名不合法；邀请链接无效、撤销、过期
   * @throws ConflictException     用户名已占用（409）、邮箱已注册（409）
   *
   * 内部流程：
   * 1. 归一化 email、trim username，依次做用户名规则、密码长度、persona 枚举、TEAM 企业名校验。
   * 2. INVITE：查 tenant_invites（联查租户），校验租户是 TEAM 且 ACTIVE、链接未撤销未过期。
   * 3. 并行查重 username / email，任一命中抛 409（邮箱与用户名是两条唯一索引）。
   * 4. bcrypt(password, 12) 生成哈希；displayName 为空时回退 username。
   * 5. 开事务：
   *    - INVITE：不建租户，直接在邀请租户下建 status=PENDING 的 USER，并把邀请 acceptedCount+1。
   *    - 其他：先建租户（FREE/PERSONAL 或 TEAM/TEAM），再建 role=ADMIN、status=ACTIVE 的用户。
   * 6. 邀请流：异步邮件通知该租户所有 ACTIVE 的管理员（失败只记 warn，不影响注册结果）。
   * 7. 非邀请流：buildUserPayload 组返回体 → issueTokens 签发并落库 refresh token。
   */
  async register(dto: RegisterDto, meta: TokenMeta = {}) {
    const email = this.normalizeEmail(dto.email)
    const username = (dto.username || '').trim()
    if (!USERNAME_RE.test(username)) {
      throw new BadRequestException('用户名需为 3-20 位字母、数字或下划线')
    }
    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException('密码至少 8 位')
    }
    if (dto.persona !== 'PERSONAL' && dto.persona !== 'TEAM' && dto.persona !== 'INVITE') {
      throw new BadRequestException('请选择注册身份（个人 / 企业）')
    }
    if (dto.persona === 'TEAM' && !(dto.orgName || '').trim()) {
      throw new BadRequestException('请填写企业名称')
    }

    // 邀请流：先校验链接（无效/过期/撤销直接拒绝，且不暴露租户敏感信息）
    let invite: { id: string; tenantId: string; tenant: { name: string } } | null = null
    if (dto.persona === 'INVITE') {
      const token = (dto.inviteToken || '').trim()
      if (!token) throw new BadRequestException('邀请链接无效')
      const row = await this.db.tenantInvite.findUnique({
        where: { token },
        include: { tenant: { select: { name: true, workspaceType: true, status: true } } },
      })
      if (!row || row.tenant.workspaceType !== 'TEAM' || row.tenant.status !== 'ACTIVE') {
        throw new BadRequestException('邀请链接无效')
      }
      if (row.revokedAt) throw new BadRequestException('邀请链接已被撤销')
      if (row.expiresAt.getTime() <= Date.now()) {
        throw new BadRequestException('邀请链接已过期，请联系管理员重新获取')
      }
      invite = { id: row.id, tenantId: row.tenantId, tenant: { name: row.tenant.name } }
    }

    const [existingUsername, existingEmail] = await Promise.all([
      this.db.user.findUnique({ where: { username } }),
      this.db.user.findUnique({ where: { email } }),
    ])
    if (existingUsername) {
      throw new ConflictException('用户名已被占用，请换一个')
    }
    if (existingEmail) {
      throw new ConflictException('该邮箱已注册，请直接登录')
    }

    const passwordHash = await bcrypt.hash(dto.password, 12)
    const displayName = (dto.displayName || '').trim() || username

    // 租户 + 用户在一个事务里创建（UserProfile 已下线，不再创建）
    const created = await this.db.$transaction(async (tx) => {
      // 邀请流：不建新租户，直接加入邀请指向的团队，状态待审批
      // users 落库示例：
      // { "role":"USER", "status":"PENDING", "tenantId":"<邀请租户id>", "emailVerified":false,
      //   "onboardingCompleted":true, "metadata":{"inviteId":"cm1invite000abcd1234"} }
      if (dto.persona === 'INVITE' && invite) {
        const user = await tx.user.create({
          data: {
            username,
            email,
            passwordHash,
            displayName,
            role: 'USER' as UserRole,
            status: 'PENDING',
            tenantId: invite.tenantId,
            emailVerified: false,
            onboardingCompleted: true,
            metadata: { inviteId: invite.id },
          },
        })
        await tx.tenantInvite.update({
          where: { id: invite.id },
          data: { acceptedCount: { increment: 1 } },
        })
        return user
      }

      const isTeam = dto.persona === 'TEAM'
      // tenants 落库示例：
      // PERSONAL → { "name":"张三 的个人空间", "plan":"FREE", "workspaceType":"PERSONAL",
      //              "status":"ACTIVE", "couponBalance":0, "monthlyTokenQuota":500000,
      //              "planUpdatedAt":null, "planExpiresAt":null }
      // TEAM     → { "name":"艾克米科技有限公司", "plan":"TEAM", "workspaceType":"TEAM",
      //              "planUpdatedAt":"2026-10-21T16:30:00.000Z" }
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

      // users 落库示例（PERSONAL / TEAM 共用）：
      // { "role":"ADMIN", "status":"ACTIVE", "tenantId":"<新租户id>",
      //   "passwordHash":"$2a$12$Qw3sT9...", "emailVerified":false, "onboardingCompleted":false,
      //   "metadata": null | {"companySize":"50-200人","position":"HRD"} }
      return tx.user.create({
        data: {
          username,
          email,
          passwordHash,
          displayName,
          role: 'ADMIN' as UserRole, // 空间创建者=租户管理员（团队管理/席位需要）
          tenantId: tenant.id,
          emailVerified: false, // 未走验证码；首次验证码登录成功后自动置 true
          metadata: isTeam
            ? { companySize: dto.companySize ?? null, position: dto.position ?? null }
            : undefined,
        },
      })
    })

    // 邀请流：不签发登录凭证，异步通知租户管理员审批，前端展示「等待审批」
    if (dto.persona === 'INVITE' && invite) {
      this.notifyAdminsNewApply(invite.tenantId, invite.tenant.name, {
        displayName, username, email,
      }).catch((err) => logger.warn('invite apply notify failed', { error: (err as Error).message }))
      // 返回示例：{ "pending": true, "tenantName": "艾克米科技有限公司" }（无 token，前端展示「等待审批」）
      return { pending: true, tenantName: invite.tenant.name }
    }

    // 返回示例（PERSONAL / TEAM）：
    // { "user": { "id":"cm1x2y3z40000abcd1234efgh", "username":"zhangsan",
    //             "email":"zhangsan@example.com", "displayName":"张三", "role":"ADMIN",
    //             "tenantId":"cm1x2y3z40001abcd5678ijkl", "plan":"FREE",
    //             "workspaceType":"PERSONAL", "couponBalance":0,
    //             "onboardingCompleted":false, "emailVerified":false },
    //   "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    //   "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
    const user = await this.buildUserPayload(created.id)
    const tokens = await this.issueTokens(user, meta)
    return { user, ...tokens }
  }

  /**
   * 新成员凭邀请注册后，邮件通知该团队全部负责人（有绑定邮箱者）。
   *
   * @param tenantId   被加入的租户 id，用来筛管理员
   * @param tenantName 租户名，写进邮件正文
   * @param applicant  申请人信息 { displayName, username, email }
   * @returns Promise<void>；单个管理员发信失败会让 Promise.all reject（调用方已 catch 并只记 warn）
   *
   * 内部流程：查该租户 role=ADMIN 且 status=ACTIVE 的用户 → 取 email → 过滤空值 →
   *          逐个调用 mailer.sendMemberApplyNotice（邮件里带前端团队页地址 config.app.frontUrl）。
   * 调用方式：register() 中不 await，属于「尽力通知」，不影响注册主流程。
   */
  private async notifyAdminsNewApply(
    tenantId: string,
    tenantName: string,
    applicant: { displayName: string; username: string; email: string },
  ) {
    const admins = await this.db.user.findMany({
      where: { tenantId, role: 'ADMIN', status: 'ACTIVE' },
      select: { email: true },
    })
    await Promise.all(
      admins
        .map((a) => a.email)
        .filter((v): v is string => !!v)
        .map((adminEmail) =>
          this.mailer.sendMemberApplyNotice(adminEmail, {
            tenantName,
            applicantName: applicant.displayName,
            username: applicant.username,
            email: applicant.email,
            teamUrl: config.app.frontUrl,
          }),
        ),
    )
  }

  // ── 邮箱验证码登录：仅允许已注册 / 已绑定该邮箱的账号（FR-4）──────
  /**
   * 邮箱验证码登录。
   *
   * @param email 用户邮箱（会 trim + 小写）
   * @param code  6 位邮箱验证码
   * @param meta  客户端信息（ip/userAgent）
   * @returns { user: AuthUserPayload, accessToken, refreshToken }（与 login() 完全一致）
   * @throws BadRequestException  验证码错误/过期；邮箱未绑定账号
   * @throws UnauthorizedException status=PENDING（待审批）或 DISABLED（禁用）
   *
   * 内部流程：
   * 1. 归一化邮箱 → verificationCodes.verifyCode 校验并删除验证码（一次性）。
   * 2. 按 email 查用户：不存在 → 400；PENDING → 401；非 ACTIVE → 401。
   * 3. 能收到验证码即证明邮箱归属，若 emailVerified=false 顺手置 true。
   * 4. 交给 login() 写登录时间并签发 token。
   * 请求示例：{ "email": "zhangsan@example.com", "code": "123456" }
   */
  async loginByCode(email: string, code: string, meta: TokenMeta = {}) {
    const normalized = this.normalizeEmail(email)
    await this.verificationCodes.verifyCode(normalized, code)

    const user = await this.db.user.findUnique({ where: { email: normalized } })
    if (!user) {
      throw new BadRequestException('该邮箱未绑定账号，请先注册或使用用户名密码登录')
    }
    if (user.status === 'PENDING') {
      throw new UnauthorizedException('你的加入申请正在等待团队管理员审批，通过后即可登录')
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('账号已被禁用')
    }
    // 能收到验证码即证明邮箱归属，顺带完成邮箱验证
    if (!user.emailVerified) {
      await this.db.user.update({ where: { id: user.id }, data: { emailVerified: true } })
    }
    return this.login(user, meta)
  }

  /**
   * 发送"登录用"验证码：仅向已绑定账号的邮箱发信，避免发信通道被滥用。
   *
   * @param email 目标邮箱（会 trim + 小写）
   * @returns { sent: true, cooldownSeconds: 60 }
   * @throws BadRequestException   邮箱未绑定账号
   * @throws UnauthorizedException 账号 PENDING（待审批）或 DISABLED（禁用）
   * @throws HttpException(429)    60 秒内重复请求（带剩余秒数）
   *
   * 内部流程：归一化邮箱 → 只查 status 字段做三道状态判断 → 委托 verificationCodes.sendCode()。
   * 真正的验证码生成、Redis 写入、发信、60 秒频控都在 verification-code.service.ts。
   * 请求示例：{ "email": "zhangsan@example.com" }
   */
  async sendLoginCode(email: string) {
    const normalized = this.normalizeEmail(email)
    const user = await this.db.user.findUnique({
      where: { email: normalized },
      select: { status: true },
    })
    if (!user) {
      throw new BadRequestException('该邮箱未绑定账号，请先注册后再使用验证码登录')
    }
    if (user.status === 'PENDING') {
      throw new UnauthorizedException('加入申请待管理员审批，暂时无法接收验证码')
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('账号已被禁用，无法接收验证码')
    }
    return this.verificationCodes.sendCode(normalized)
  }

  /**
   * 组装前端用户体（联查租户套餐/空间类型）。
   *
   * @param userId users.id
   * @returns AuthUserPayload（11 个字段，见接口定义）
   * @throws Prisma P2025（findUniqueOrThrow 查不到）—— 由调用方决定转成什么异常
   *
   * 字段来源：id/username/email/displayName/role/tenantId/onboardingCompleted/emailVerified 取自 users；
   *           plan/workspaceType/couponBalance 取自关联租户 tenants。
   * 内部流程：user.findUniqueOrThrow(include tenant) → 把嵌套的 tenant 三个字段扁平化到顶层。
   * 返回示例：{ "id":"cm1x2y3z40000abcd1234efgh", "username":"zhangsan",
   *             "email":"zhangsan@example.com", "displayName":"张三", "role":"ADMIN",
   *             "tenantId":"cm1x2y3z40001abcd5678ijkl", "plan":"FREE",
   *             "workspaceType":"PERSONAL", "couponBalance":0,
   *             "onboardingCompleted":false, "emailVerified":false }
   */
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
  /**
   * 密码校验（LocalStrategy 的 validate 入口，只做认证，不签发 token）。
   *
   * @param username 用户名或邮箱（二选一，同一字段）
   * @param password 明文密码
   * @returns 去掉 passwordHash 后的完整 users 行（含 status/metadata/lastLoginAt 等）
   * @throws UnauthorizedException 用户不存在 / 待审批 / 已禁用 / 密码错误
   *
   * 内部流程：findFirst(OR username|email) → 状态三连判断（PENDING、非 ACTIVE）→
   *          bcrypt.compare 校验密码 → 解构剔除 passwordHash 后返回。
   * 调用链：POST /api/auth/login → LocalAuthGuard → LocalStrategy → 本方法。
   * 入参示例：username='zhangsan'（也可传邮箱 'zhangsan@example.com'），password='Passw0rd!'
   */
  // 返回示例（已剔除 passwordHash）：
  // { "id":"cm1x2y3z40000abcd1234efgh", "username":"zhangsan", "email":"zhangsan@example.com",
  //   "displayName":"张三", "avatar":null, "role":"ADMIN", "status":"ACTIVE",
  //   "tenantId":"cm1x2y3z40001abcd5678ijkl", "onboardingCompleted":true, "emailVerified":true,
  //   "metadata":null, "lastLoginAt":"2026-10-21T08:12:34.000Z",
  //   "lastLoginIp":"::ffff:192.168.1.23", "createdAt":"2026-10-01T02:00:00.000Z",
  //   "updatedAt":"2026-10-21T08:12:34.000Z" }
  async validateUser(username: string, password: string) {
    if (!username?.trim() || !password?.trim()) {
      throw new BadRequestException('用户名和密码不能为空')
    }
    const user = await this.db.user.findFirst({
      where: { OR: [{ username: username.trim() }, { email: username.trim() }] },
    })
    if (!user) throw new UnauthorizedException('用户不存在')
    if (user.status === 'PENDING') {
      throw new UnauthorizedException('你的加入申请正在等待团队管理员审批，通过后即可登录')
    }
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('账号已被禁用')

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new UnauthorizedException('密码错误')

    const { passwordHash, ...result } = user
    return result
  }

  // ── 登录并返回 Token（user 体携带套餐/空间类型，供前端 persona 路由）──
  /**
   * 登录成功后的统一出口：记录登录信息 + 签发 token（密码登录与验证码登录共用）。
   *
   * @param user validateUser 的返回值（至少含 id/username/role/tenantId）
   * @param meta 客户端信息，ip 会写入 last_login_ip
   * @returns { user: AuthUserPayload, accessToken, refreshToken }
   * @throws UnauthorizedException 用户不存在（buildUserPayload 查不到时）
   *
   * 内部流程：
   * 1. 更新 users.last_login_at=now、last_login_ip=ip（截 45 字符）。
   * 2. buildUserPayload 重新查库，保证返回体里的套餐/空间类型是最新值。
   * 3. issueTokens 用 { id, username, role, tenantId } 签双 token，并把 refresh 哈希落库。
   * 写入字段示例：{ "lastLoginAt":"2026-10-21T16:45:12.000Z", "lastLoginIp":"::ffff:192.168.1.23" }
   */
  // JWT payload 只带 { sub, username, role, tenantId, jti }，不含 email/plan（前端靠 user 体取）
  // 返回示例：{ "user": {...AuthUserPayload}, "accessToken": "eyJ...", "refreshToken": "eyJ..." }
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
  /**
   * 刷新访问令牌（refresh token 轮转）。
   *
   * @param rawRefreshToken 前端持有的 refresh JWT 明文
   * @param meta            客户端信息，落到新 refresh token 行
   * @returns { accessToken: string, refreshToken: string }（新的一对）
   * @throws UnauthorizedException 验签失败/过期、DB 无记录、归属不符、重放（已撤销）、用户被禁用、并发抢锁失败
   *
   * 内部流程：
   * 1. jwtService.verify（refreshSecret）解析 payload，失败即 401。
   * 2. 按 sha256(明文) 查 refresh_tokens：无记录或 userId≠payload.sub → 401。
   * 3. 命中已撤销行 = 疑似泄漏/重放 → 吊销该用户全部 token、记 warn 日志、401。
   * 4. 校验行过期时间与用户 status=ACTIVE。
   * 5. 事务内：签新 token 对 → 建新行 → 条件更新旧行（revokedAt=now、replacedById=新行 id）；
   *    若旧行已被并发请求抢先撤销（count=0）→ 401，杜绝同一 refresh 双花。
   * 请求示例：{ "refreshToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
   */
  // 返回示例：{ "accessToken": "eyJ...(新，7d)", "refreshToken": "eyJ...(新，30d)" }
  // 落库示例（新行）：{ "userId":"cm1x2y3z40000abcd1234efgh", "tokenHash":"9f2c4a7d...",
  //                      "expiresAt":"2026-11-20T08:12:34.000Z", "ip":"::ffff:192.168.1.23",
  //                      "userAgent":"Mozilla/5.0 ...", "revokedAt":null, "replacedById":null }
  // 旧行更新示例：{ "revokedAt":"2026-10-21T09:00:00.000Z", "replacedById":"cm1rt1111abcd9999wxyz" }
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
        data: this.refreshTokenRow(user.id, tokens.refreshToken, meta),
      })
      const claimed = await tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: newRow.id },
      })
      if (claimed.count === 0) throw new UnauthorizedException('Refresh Token 已被使用，请重新登录')
      return tokens
    })
  }

  /**
   * 吊销用户全部有效 refresh token（改密、重置密码、检测到重放时调用）。
   *
   * @param userId users.id
   * @returns Promise<void>
   *
   * 内部流程：updateMany(where userId + revokedAt=null, data revokedAt=now)。
   * 已撤销的行不会被二次覆盖，保留首次撤销时间与 replacedById 链。
   * 效果：该用户所有设备下次刷新都会 401，必须重新登录；access token 因是无状态 JWT 仍在有效期内可用。
   */
  private async revokeAllUserTokens(userId: string) {
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  // ── 获取当前用户信息（含套餐/空间类型/引导状态）────────────────
  /**
   * 获取当前登录用户资料（前端进入应用时的自愈刷新入口）。
   *
   * @param userId 由 JwtStrategy 从 access token 的 sub 注入（req.user.userId）
   * @returns AuthUserPayload
   * @throws UnauthorizedException 用户不存在（含被物理删除的情况）
   *
   * 内部流程：直接复用 buildUserPayload；把 Prisma 的「查不到」异常统一转换成 401，
   *          避免把 ORM 细节暴露到 HTTP 层。
   */
  async getProfile(userId: string) {
    try {
      return await this.buildUserPayload(userId)
    } catch {
      throw new UnauthorizedException('用户不存在')
    }
  }

  // ── 完成新手引导（3 步欢迎引导结束/跳过后持久化，FR-3）─────────
  /**
   * 标记新手引导已完成。
   *
   * @param userId 当前登录用户 id
   * @returns AuthUserPayload（其中 onboardingCompleted=true），前端拿到后可直接 setUser
   * @throws UnauthorizedException 用户不存在（buildUserPayload 抛异常时未被 catch，会冒泡为 500）
   *
   * 内部流程：update users.onboarding_completed=true → 重新 buildUserPayload 返回最新体。
   * 写入示例：users.onboarding_completed = true
   */
  async completeOnboarding(userId: string) {
    await this.db.user.update({
      where: { id: userId },
      data: { onboardingCompleted: true },
    })
    return this.buildUserPayload(userId)
  }

  // ── 修改密码 ─────────────────────────────────────────────────
  /**
   * 修改密码（需登录态）。
   *
   * @param userId      当前登录用户 id
   * @param oldPassword 旧密码明文
   * @param newPassword 新密码明文（调用方 controller 已保证 ≥8 位）
   * @returns { success: true }
   * @throws UnauthorizedException 用户不存在 / 旧密码错误
   *
   * 内部流程：查用户 → bcrypt.compare 校验旧密码 → bcrypt(new,12) 覆盖 password_hash →
   *          revokeAllUserTokens 让所有设备重新登录。
   * 注意：这里没有再校验新密码长度，长度限制由 controller 的 ApiBody + 前置校验保证。
   * 请求示例：{ "oldPassword": "Passw0rd!", "newPassword": "NewPass2026" }
   * 副作用：users.password_hash 覆盖为新 bcrypt 值；该用户全部 refresh_tokens.revokedAt 置 now
   */
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

  // ── 忘记密码：发重置邮件（一次性 token 存 Redis，15 分钟有效，60 秒频控）──
  /** 重置链接有效期：15 分钟（900 秒），以毫秒形式传给 RedisService.set */
  private PWD_RESET_TTL_SECONDS = 15 * 60

  /**
   * 一次性重置 token 的 Redis key。
   * @param token randomBytes(24) 的 hex（48 字符）
   * @returns 形如 'pwdreset:9c1f8e7d6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d'；value 是邮箱
   */
  private pwdResetKey(token: string) {
    return `pwdreset:${token}`
  }

  /**
   * 忘记密码的频控 key（60 秒内只允许发一次）。
   * @param email 已归一化的邮箱
   * @returns 形如 'pwdreset:rl:zhangsan@example.com'
   */
  private pwdResetRateKey(email: string) {
    return `pwdreset:rl:${email}`
  }

  // ── 忘记密码：入参与 Redis 落点示例 ───────────────────────────
  /**
   * 忘记密码：向已绑定账号的邮箱发送一次性重置链接。
   *
   * @param email 用户邮箱（会 trim + 小写）
   * @returns { sent: true, message: '重置链接已发送至邮箱，15 分钟内有效' }
   * @throws BadRequestException 60 秒内重复请求；邮箱未绑定账号或账号非 ACTIVE
   *
   * 内部流程：
   * 1. Redis SET NX EX 60 占频控位，失败 → 400（防邮件通道滥用）。
   * 2. 查用户，必须存在且 status=ACTIVE（与验证码登录口径一致，不做账号枚举豁免）。
   * 3. randomBytes(24).hex 生成 48 位 token，Redis 存 pwdreset:<token> → email，TTL 900s。
   * 4. 拼 `${frontUrl}/reset-password?token=...` 交给 mailer 发信，记 info 日志。
   * 注意：token 只存 Redis 不落库；重置成功后会被删除（一次性）。
   * 请求示例：{ "email": "zhangsan@example.com" }
   * Redis 示例：
   */
  //   pwdreset:rl:zhangsan@example.com = "1"                       (TTL 60s，频控)
  //   pwdreset:9c1f8e7d6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d = "zhangsan@example.com" (TTL 900s)
  // 邮件链接示例：http://localhost:5173/reset-password?token=9c1f8e7d6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d
  // 返回示例：{ "sent": true, "message": "重置链接已发送至邮箱，15 分钟内有效" }
  async forgotPassword(email: string) {
    const normalized = this.normalizeEmail(email)
    // 60 秒重发频控（与验证码同策略），防邮件通道被滥用
    const allowed = await this.redis.getClient().set(
      this.pwdResetRateKey(normalized), '1', 'EX', 60, 'NX',
    )
    if (allowed !== 'OK') {
      throw new BadRequestException('发送过于频繁，请 1 分钟后再试')
    }

    const user = await this.db.user.findUnique({ where: { email: normalized } })
    if (!user || user.status !== 'ACTIVE') {
      // 明确报错（与验证码登录口径一致：仅已绑定邮箱可操作）
      throw new BadRequestException('该邮箱未绑定账号，请先注册或使用用户名密码登录')
    }

    const token = randomBytes(24).toString('hex')
    await this.redis.set(this.pwdResetKey(token), normalized, this.PWD_RESET_TTL_SECONDS * 1000)
    const resetUrl = `${config.app.frontUrl}/reset-password?token=${token}`
    await this.mailer.sendPasswordReset(normalized, resetUrl, this.PWD_RESET_TTL_SECONDS / 60)
    logger.info('auth: password reset mail sent', { email: normalized })
    return { sent: true, message: '重置链接已发送至邮箱，15 分钟内有效' }
  }

  /**
   * 重置密码：凭邮件里的一次性 token 设置新密码（无需登录态）。
   *
   * @param token       邮件链接中的 token（48 位 hex）
   * @param newPassword 新密码明文，至少 8 位
   * @returns { success: true, message: '密码已重置，请使用新密码登录' }
   * @throws BadRequestException token 为空 / 已失效 / 新密码不足 8 位 / 账号不存在或被禁用
   *
   * 内部流程：校验参数 → Redis get pwdreset:<token> 拿邮箱（拿不到即失效）→ 查用户且 ACTIVE →
   *          bcrypt(new,12) 覆盖 password_hash → del token（一次性）→ 吊销全部 refresh token。
   * 请求示例：{ "token": "9c1f8e7d6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d", "newPassword": "NewPass2026" }
   */
  async resetPassword(token: string, newPassword: string) {
    const trimmed = (token || '').trim()
    if (!trimmed) throw new BadRequestException('重置链接无效，请重新申请')
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('密码至少 8 位')
    }
    const email = await this.redis.get(this.pwdResetKey(trimmed))
    if (!email) {
      throw new BadRequestException('重置链接已失效，请重新申请')
    }
    const user = await this.db.user.findUnique({ where: { email } })
    if (!user || user.status !== 'ACTIVE') {
      throw new BadRequestException('账号不存在或已被禁用')
    }

    const passwordHash = await bcrypt.hash(newPassword, 12)
    await this.db.user.update({ where: { id: user.id }, data: { passwordHash } })
    // 一次性消费 + 吊销全部既有会话（旧密码登录态全部失效）
    await this.redis.del(this.pwdResetKey(trimmed))
    await this.revokeAllUserTokens(user.id)
    logger.info('auth: password reset done', { email })
    return { success: true, message: '密码已重置，请使用新密码登录' }
  }

  // ── 内部方法 ─────────────────────────────────────────────────

  /**
   * 邮箱归一化：trim + 转小写 + 格式校验（注册/登录/重置四处统一口径）。
   *
   * @param raw 原始邮箱输入（可为 undefined/空串）
   * @returns 小写且去首尾空格的合法邮箱
   * @throws BadRequestException 格式不合法（正则要求 local@domain.tld）
   *
   * 内部流程：trim → toLowerCase → 正则 /^[^\s@]+@[^\s@]+\.[^\s@]+$/ 校验。
   * 示例：' ZhangSan@Example.com ' → 'zhangsan@example.com'；'abc' → 400「邮箱格式不正确」
   */
  private normalizeEmail(raw: string): string {
    const email = (raw || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('邮箱格式不正确')
    }
    return email
  }

  /**
   * 构造 refresh token 落库行（签发与轮转共用，保证过期时间/字段口径一致）。
   *
   * @param userId   归属用户
   * @param rawToken refresh JWT 明文（只取 sha256，不存明文）
   * @param meta     客户端信息（ip 截 45、userAgent 截 500，缺失存 null）
   * @returns Prisma create 所需的 data 对象（不含 id/createdAt，由数据库默认值生成）
   *
   * 内部流程：sha256(明文) → expiresAt = now + ttlSeconds(refreshExpiresIn)*1000。
   * 示例：
   * {
   *   "userId": "cm1x2y3z40000abcd1234efgh",
   *   "tokenHash": "9f2c4a7d1b8e3c5f6a0d2b4e8c1f3a5b7d9e0c2a4f6b8d1e3a5c7f9b0d2e4c6a",
   *   "expiresAt": "2026-11-20T08:12:34.000Z",
   *   "ip": "::ffff:192.168.1.23",
   *   "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0"
   * }
   */
  private refreshTokenRow(userId: string, rawToken: string, meta: TokenMeta = {}) {
    return {
      userId,
      tokenHash: sha256(rawToken),
      expiresAt: new Date(Date.now() + ttlSeconds(config.jwt.refreshExpiresIn) * 1000),
      ip: meta.ip?.slice(0, 45) || null,
      userAgent: meta.userAgent?.slice(0, 500) || null,
    }
  }

  /**
   * 签发 token 对并把 refresh token（哈希）持久化。
   *
   * @param user 最小身份快照 { id, username, role, tenantId }
   * @param meta 客户端信息（落 refresh_tokens.ip / user_agent）
   * @returns { accessToken, refreshToken }
   *
   * 内部流程：buildTokens 签名 → refreshToken.create 存哈希行。
   * 与 refreshToken() 里的内联逻辑等价，区别是这里不做轮转/旧行撤销。
   * 调用方：register()（注册即登录）、login()。
   */
  private async issueTokens(
    user: { id: string; username: string; role: string; tenantId: string },
    meta: TokenMeta = {},
  ) {
    const tokens = await this.buildTokens(user)
    await this.db.refreshToken.create({
      data: this.refreshTokenRow(user.id, tokens.refreshToken, meta),
    })
    return tokens
  }

  /**
   * 只做签名，不落库（refresh payload 带 jti；DB 行由调用方持久化/轮转）。
   *
   * @param user 最小身份快照 { id, username, role, tenantId }
   * @returns { accessToken, refreshToken }
   * payload 示例：
   * { "sub":"cm1x2y3z40000abcd1234efgh", "username":"zhangsan", "role":"ADMIN",
   *   "tenantId":"cm1x2y3z40001abcd5678ijkl",
   *   "jti":"5b1c0f0e-8a2d-4c5e-9f6a-1d2b3c4e5f60", "iat":1761123456, "exp":1761728256 }
   * 返回示例：{ "accessToken": "eyJ...（7d，JWT_SECRET）",
   *             "refreshToken": "eyJ...（30d，JWT_REFRESH_SECRET）" }
   * 注意：两个 token 共用同一 payload 对象，因此 jti 相同，区分靠密钥与 exp。
   */
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
