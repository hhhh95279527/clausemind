// server/src/team/team.service.ts
// 团队席位与成员管理（FR-18，/api/team）：
//   GET    /members             成员列表 + 席位使用（团队空间）
//   POST   /members             演示环境直接创建账号并入团队（负责人，占席位）
//   PATCH  /members/:id/role    编辑角色（负责人）
//   DELETE /members/:id         移除成员（负责人，不可移除自己/最后一个负责人）
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import * as bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { AuditService } from '../audit/audit.service.js'

const ALLOWED_ROLES = ['ADMIN', 'MANAGER', 'USER'] as const
type MemberRole = (typeof ALLOWED_ROLES)[number]
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

@Injectable()
export class TeamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  private async assertAccess(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.entitlements.assertTeamSpace(tenant.plan)
    return tenant
  }

  private serialize(u: {
    id: string; username: string; email: string | null; displayName: string | null
    role: string; status: string; lastLoginAt: Date | null; createdAt: Date
  }) {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      status: u.status,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    }
  }

  /** 成员列表 + 席位概况 */
  async listMembers(tenantId: string) {
    await this.assertAccess(tenantId)
    const [users, snap] = await Promise.all([
      this.db.user.findMany({
        where: { tenantId },
        select: {
          id: true, username: true, email: true, displayName: true,
          role: true, status: true, lastLoginAt: true, createdAt: true,
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
      this.entitlements.getEntitlementSnapshot(tenantId),
    ])
    return {
      members: users.map((u) => this.serialize(u)),
      plan: snap?.plan ?? null,
      planLabel: snap?.label ?? null,
      seats: snap?.seats ?? null,
      usedSeats: snap?.usedSeats ?? users.length,
    }
  }

  /**
   * 邀请/创建成员（演示环境直接创建已激活账号）。
   * 新成员凭邮箱 + 一次性初始密码登录；正式环境将改为邮件接受邀请流程。
   */
  async createMember(tenantId: string, operatorId: string, dto: { displayName?: string; email?: string; role?: string }) {
    await this.assertAccess(tenantId)

    const email = (dto.email ?? '').trim().toLowerCase()
    const displayName = (dto.displayName ?? '').trim()
    const role = (dto.role ?? 'USER') as MemberRole

    if (!displayName) throw new BadRequestException('请填写成员姓名')
    if (displayName.length > 100) throw new BadRequestException('姓名过长（最多 100 字）')
    if (!EMAIL_RE.test(email)) throw new BadRequestException('请填写正确的邮箱地址')
    if (!ALLOWED_ROLES.includes(role)) throw new BadRequestException('角色不合法')

    // 平台级唯一性：email 跨租户唯一（登录凭证），因此 findFirst 不带 tenantId
    const exists = await this.db.user.findFirst({ where: { OR: [{ email }] } })
    if (exists) throw new ConflictException('该邮箱已被账号使用')

    // 席位拦截（SEAT_LIMIT → 403 PLAN_LIMIT，前端引导增购）
    await this.entitlements.assertSeatAvailable(tenantId)

    // 由邮箱生成唯一登录名
    const base = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '').slice(0, 20) || 'member'
    let username = base
    for (let i = 1; i <= 1000; i++) {
      if (!(await this.db.user.findUnique({ where: { username } }))) break
      username = `${base}_${i}`
    }

    // 一次性初始密码（去除易混淆字符）
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
    const raw = randomBytes(8)
    let password = ''
    for (let i = 0; i < 8; i++) password += alphabet[raw[i] % alphabet.length]

    const user = await this.db.user.create({
      data: {
        username,
        email,
        displayName,
        role,
        status: 'ACTIVE',
        emailVerified: false,
        onboardingCompleted: true,
        passwordHash: await bcrypt.hash(password, 12),
        tenantId,
      },
      select: {
        id: true, username: true, email: true, displayName: true,
        role: true, status: true, lastLoginAt: true, createdAt: true,
      },
    })

    await this.audit.log({
      tenantId,
      userId: operatorId,
      action: 'TEAM_MEMBER_CREATE',
      resource: 'user',
      resourceId: user.id,
      detail: { displayName, email, role, demoDirectJoin: true },
    })

    return { member: this.serialize(user), username, initialPassword: password }
  }

  /** 编辑角色：不可降级自己；不可移除最后一个负责人 */
  async updateRole(tenantId: string, operatorId: string, memberId: string, role?: string) {
    await this.assertAccess(tenantId)
    if (!role || !ALLOWED_ROLES.includes(role as MemberRole)) {
      throw new BadRequestException('角色不合法')
    }
    const member = await this.db.user.findFirst({ where: { id: memberId, tenantId } })
    if (!member) throw new NotFoundException('成员不存在')

    if (member.id === operatorId && role !== 'ADMIN') {
      throw new BadRequestException('不能修改自己的负责人角色')
    }
    if (member.role === 'ADMIN' && role !== 'ADMIN') {
      const otherAdmins = await this.db.user.count({
        where: { tenantId, role: 'ADMIN', status: { not: 'DISABLED' }, id: { not: member.id } },
      })
      if (otherAdmins === 0) throw new BadRequestException('团队至少保留一名负责人')
    }

    const updated = await this.db.user.update({
      where: { id: member.id },
      data: { role: role as MemberRole },
      select: {
        id: true, username: true, email: true, displayName: true,
        role: true, status: true, lastLoginAt: true, createdAt: true,
      },
    })
    await this.audit.log({
      tenantId,
      userId: operatorId,
      action: 'TEAM_MEMBER_ROLE_UPDATE',
      resource: 'user',
      resourceId: member.id,
      detail: { displayName: member.displayName, from: member.role, to: role },
    })
    return { member: this.serialize(updated) }
  }

  /** 移除成员：不可移除自己；不可移除最后一个负责人 */
  async removeMember(tenantId: string, operatorId: string, memberId: string) {
    await this.assertAccess(tenantId)
    if (memberId === operatorId) throw new BadRequestException('不能移除自己，请移交负责人后再操作')

    const member = await this.db.user.findFirst({ where: { id: memberId, tenantId } })
    if (!member) throw new NotFoundException('成员不存在')
    if (member.role === 'ADMIN') {
      const otherAdmins = await this.db.user.count({
        where: { tenantId, role: 'ADMIN', status: { not: 'DISABLED' }, id: { not: member.id } },
      })
      if (otherAdmins === 0) throw new BadRequestException('团队至少保留一名负责人')
    }

    await this.db.user.delete({ where: { id: member.id } })
    await this.audit.log({
      tenantId,
      userId: operatorId,
      action: 'TEAM_MEMBER_REMOVE',
      resource: 'user',
      resourceId: member.id,
      detail: { displayName: member.displayName, email: member.email },
    })
    return { ok: true }
  }
}
