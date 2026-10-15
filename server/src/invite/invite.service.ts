// server/src/invite/invite.service.ts
// 团队邀请链接与加入审批：
//   管理员生成链接（7 天有效、可多人接受）→ 受邀人公开注册为 PENDING 成员 →
//   管理员审批通过（占席位，可登录）/ 拒绝（删除申请，可重新申请）。
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { randomBytes } from 'node:crypto'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { AuditService } from '../audit/audit.service.js'
import { MailerService } from '../auth/mailer.service.js'
import { config as appConfig } from '../config/index.js'

/** 邀请链接有效期（天） */
const INVITE_TTL_DAYS = 7

@Injectable()
export class InviteService {
  private readonly logger = new Logger('Invite')

  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
  ) {}

  // ── 管理员：邀请链接管理 ─────────────────────────────────────────────

  /** 生成一条新的团队邀请链接（每次点击「确定邀请」生成一条） */
  async createInvite(tenantId: string, operatorId: string) {
    const tenant = await this.assertTeamTenant(tenantId)
    const token = randomBytes(24).toString('hex') // 48 位 URL 安全随机串
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 3600 * 1000)
    const invite = await this.db.tenantInvite.create({
      data: { tenantId, createdById: operatorId, token, expiresAt },
    })
    await this.audit.log({
      tenantId, userId: operatorId,
      action: 'TEAM_INVITE_CREATE',
      resource: 'tenant_invite',
      resourceId: invite.id,
      detail: { expiresAt: expiresAt.toISOString() },
    })
    return {
      id: invite.id,
      token: invite.token,
      url: `${appConfig.app.frontUrl}/invite/${invite.token}`,
      expiresAt: invite.expiresAt,
      acceptedCount: 0,
      tenantName: tenant.name,
    }
  }

  /** 作废邀请链接（已注册的 PENDING 申请不受影响） */
  async revokeInvite(tenantId: string, operatorId: string, inviteId: string) {
    await this.assertTeamTenant(tenantId)
    const invite = await this.db.tenantInvite.findFirst({ where: { id: inviteId, tenantId } })
    if (!invite) throw new NotFoundException('邀请链接不存在')
    if (!invite.revokedAt) {
      await this.db.tenantInvite.update({
        where: { id: invite.id },
        data: { revokedAt: new Date() },
      })
      await this.audit.log({
        tenantId, userId: operatorId,
        action: 'TEAM_INVITE_REVOKE',
        resource: 'tenant_invite',
        resourceId: invite.id,
      })
    }
    return { ok: true }
  }

  // ── 公开：落地页查询（无需登录，不得泄露敏感信息） ─────────────────────

  async getPublicInvite(token: string) {
    const invite = await this.db.tenantInvite.findUnique({
      where: { token },
      include: {
        tenant: { select: { name: true, plan: true, workspaceType: true, status: true } },
      },
    })
    if (!invite || invite.tenant.status !== 'ACTIVE' || invite.tenant.workspaceType !== 'TEAM') {
      return { valid: false, reason: 'NOT_FOUND' }
    }
    if (invite.revokedAt) return { valid: false, reason: 'REVOKED', tenantName: invite.tenant.name }
    if (invite.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: 'EXPIRED', tenantName: invite.tenant.name }
    }
    const inviter = await this.db.user.findUnique({
      where: { id: invite.createdById },
      select: { displayName: true, username: true },
    })
    const snap = await this.entitlements.getEntitlementSnapshot(invite.tenantId)
    return {
      valid: true,
      tenantName: invite.tenant.name,
      planLabel: snap?.label ?? null,
      inviterName: inviter?.displayName || inviter?.username || '团队管理员',
      expiresAt: invite.expiresAt,
    }
  }

  // ── 管理员：待审批成员直接从 GET /api/team/members（含 PENDING 行）渲染 ──

  /** 审批通过：PENDING → ACTIVE，此刻做席位拦截；通过后邮件通知申请人 */
  async approve(tenantId: string, operatorId: string, memberId: string) {
    await this.assertTeamTenant(tenantId)
    const member = await this.db.user.findFirst({ where: { id: memberId, tenantId } })
    if (!member) throw new NotFoundException('成员不存在')
    if (member.status !== 'PENDING') throw new BadRequestException('该成员不在待审批状态')

    // 审批通过才占席位：席位满则提示增购，申请保留待处理
    await this.entitlements.assertSeatAvailable(tenantId)

    await this.db.user.update({ where: { id: member.id }, data: { status: 'ACTIVE' } })
    await this.audit.log({
      tenantId, userId: operatorId,
      action: 'TEAM_MEMBER_APPROVE',
      resource: 'user',
      resourceId: member.id,
      detail: { displayName: member.displayName, username: member.username },
    })
    if (member.email) {
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
        .then((t) => this.mailer.sendApplyResult(member.email!, {
          tenantName: t?.name ?? '团队',
          approved: true,
          frontUrl: appConfig.app.frontUrl,
        }))
        .catch((err) => this.logger.warn(`审批通过通知邮件失败：${(err as Error).message}`))
    }
    return { ok: true }
  }

  /** 审批拒绝：删除申请（无业务数据），邮箱/用户名释放后可重新申请；邮件通知申请人 */
  async reject(tenantId: string, operatorId: string, memberId: string) {
    await this.assertTeamTenant(tenantId)
    const member = await this.db.user.findFirst({ where: { id: memberId, tenantId } })
    if (!member) throw new NotFoundException('成员不存在')
    if (member.status !== 'PENDING') throw new BadRequestException('该成员不在待审批状态')

    await this.db.user.delete({ where: { id: member.id } })
    await this.audit.log({
      tenantId, userId: operatorId,
      action: 'TEAM_MEMBER_REJECT',
      resource: 'user',
      resourceId: member.id,
      detail: { displayName: member.displayName, username: member.username, email: member.email },
    })
    if (member.email) {
      this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
        .then((t) => this.mailer.sendApplyResult(member.email!, {
          tenantName: t?.name ?? '团队',
          approved: false,
          frontUrl: appConfig.app.frontUrl,
        }))
        .catch((err) => this.logger.warn(`审批拒绝通知邮件失败：${(err as Error).message}`))
    }
    return { ok: true }
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private async assertTeamTenant(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.entitlements.assertTeamSpace(tenant.plan)
    return tenant
  }
}
