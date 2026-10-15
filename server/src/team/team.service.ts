// server/src/team/team.service.ts
// 团队席位与成员管理（FR-18，/api/team）：
//   GET    /members             成员列表 + 席位使用（含 PENDING 待审批成员）
//   PATCH  /members/:id/role    编辑角色（负责人）
//   DELETE /members/:id         移除成员（负责人，不可移除自己/最后一个负责人）
// 邀请链接生成/作废、成员加入审批（approve/reject）见 invite 模块。
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { AuditService } from '../audit/audit.service.js'

const ALLOWED_ROLES = ['ADMIN', 'MANAGER', 'USER'] as const
type MemberRole = (typeof ALLOWED_ROLES)[number]

// 成员返回字段（列表/创建/改角色三处统一，与 serialize 入参形状一致）
const MEMBER_SELECT = {
  id: true, username: true, email: true, displayName: true,
  role: true, status: true, lastLoginAt: true, createdAt: true,
} as const

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

  /** 降级/移除负责人前的红线：团队至少保留一名启用状态的负责人 */
  private async assertNotLastAdmin(tenantId: string, memberId: string) {
    const otherAdmins = await this.db.user.count({
      where: { tenantId, role: 'ADMIN', status: { not: 'DISABLED' }, id: { not: memberId } },
    })
    if (otherAdmins === 0) throw new BadRequestException('团队至少保留一名负责人')
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
        select: MEMBER_SELECT,
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
      await this.assertNotLastAdmin(tenantId, member.id)
    }

    const updated = await this.db.user.update({
      where: { id: member.id },
      data: { role: role as MemberRole },
      select: MEMBER_SELECT,
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
      await this.assertNotLastAdmin(tenantId, member.id)
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
