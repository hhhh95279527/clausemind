// server/src/billing/orders.service.ts
// 模拟订单与券包（FR-13）：不接真实支付，收银台一键 PAID 立即生效。
// - 价格/权益只取自 plans.config.ts，客户端只传商品 code，禁止传价
// - mock-pay 在事务内置 PAID 并应用权益（plan/workspaceType/planExpiresAt/couponBalance）
// - 所有关键动作写审计日志；查询全部显式 tenantId
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { Prisma, Tenant } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { EntitlementsService } from './entitlements.service.js'
import { getCheckoutItem, type CheckoutItem, type CheckoutItemDef } from './plans.config.js'

export type PayChannel = 'WECHAT' | 'ALIPAY'

/** 下单前的套餐/空间校验：不允许跨曲线乱买、企业版只走留资 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  // ── 创建模拟订单（PENDING，价格由服务端目录决定）──────────────────────────
  async createOrder(tenantId: string, userId: string, itemCode: string) {
    const item = getCheckoutItem(itemCode)
    if (!item) throw new BadRequestException('未知商品')

    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')

    this.assertPurchasable(tenant, item)

    const order = await this.db.order.create({
      data: {
        tenantId,
        kind: item.kind,
        period: item.period,
        targetPlan: item.targetPlan,
        couponQty: item.couponQty,
        amountFen: item.amountFen,
        status: 'PENDING',
        createdById: userId,
      },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'ORDER_CREATE',
      resource: 'order',
      resourceId: order.id,
      detail: { item: item.item, kind: item.kind, amountFen: item.amountFen },
    })

    return this.serialize(order)
  }

  /** 当前租户订单（新→旧，上限 50） */
  async listOrders(tenantId: string) {
    const orders = await this.db.order.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    })
    return orders.map((o) => this.serialize(o))
  }

  // ── 模拟支付：PENDING → PAID，事务内应用权益 ─────────────────────────────
  async mockPay(tenantId: string, userId: string, orderId: string, channel: PayChannel) {
    const order = await this.db.order.findFirst({ where: { id: orderId, tenantId } })
    if (!order) throw new NotFoundException('订单不存在')
    if (order.status === 'PAID') throw new ConflictException('订单已支付，请勿重复支付')
    if (order.status === 'CANCELLED') throw new ConflictException('订单已取消')

    const item = getCheckoutItem(
      order.kind === 'COUPON_PACK'
        ? 'COUPON_PACK'
        : `${order.targetPlan}_${order.period === 'YEAR' ? 'YEARLY' : 'MONTHLY'}`,
    )
    if (!item) throw new BadRequestException('订单商品信息无效')

    const now = new Date()
    const paid = await this.db.$transaction(async (tx) => {
      // 条件认领：仅 PENDING 可置 PAID，防并发/双击下事务内重复发权益。
      // count !== 1（已被支付/取消）即抛错回滚整个事务。
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: now },
      })
      if (claimed.count !== 1) throw new ConflictException('订单状态已变更，请刷新后重试')

      const tenant = await tx.tenant.findUnique({ where: { id: tenantId } })
      if (!tenant) throw new NotFoundException('工作空间不存在')

      const tenantPatch = this.buildEffectPatch(tenant, item, now)

      await tx.tenant.update({ where: { id: tenantId }, data: tenantPatch })
      return tx.order.findUniqueOrThrow({ where: { id: order.id } })
    })

    const effect = this.effectSummary(item)
    await this.audit.log({
      tenantId, userId,
      action: 'ORDER_PAID',
      resource: 'order',
      resourceId: paid.id,
      detail: {
        orderNo: this.orderNo(paid.id, paid.paidAt ?? now),
        item: item.item,
        kind: item.kind,
        amountFen: paid.amountFen,
        channel,
        effect,
      },
    })

    const entitlement = await this.entitlements.getEntitlementSnapshot(tenantId)
    return { order: this.serialize(paid), entitlement }
  }

  // ── 取消订阅（二次确认；权益保留到期，到期定时任务降级 FREE）──────────────
  async cancelSubscription(tenantId: string, userId: string, confirm: boolean) {
    if (!confirm) {
      throw new BadRequestException('请二次确认取消订阅')
    }
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    if (tenant.plan !== 'PERSONAL') {
      throw new BadRequestException('当前没有生效中的个人版订阅')
    }
    if (!tenant.planExpiresAt || tenant.planExpiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('订阅已到期，无需取消')
    }
    if (tenant.cancelAtPeriodEnd) {
      throw new ConflictException('已设置到期取消，请勿重复操作')
    }

    await this.db.tenant.update({
      where: { id: tenantId },
      data: { cancelAtPeriodEnd: true },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'SUBSCRIPTION_CANCEL_SCHEDULED',
      resource: 'tenant',
      resourceId: tenantId,
      detail: { plan: tenant.plan, planExpiresAt: tenant.planExpiresAt.toISOString() },
    })

    const entitlement = await this.entitlements.getEntitlementSnapshot(tenantId)
    return { entitlement }
  }

  // ── 企业版留资（ENTERPRISE 定制 / 席位增购咨询，仅审计落库）──────────────
  async createEnterpriseLead(
    tenantId: string,
    userId: string,
    body: { company?: string; teamSize?: string; contact?: string; note?: string },
  ) {
    const company = (body.company || '').trim().slice(0, 100)
    const contact = (body.contact || '').trim().slice(0, 100)
    const teamSize = (body.teamSize || '').trim().slice(0, 30)
    const note = (body.note || '').trim().slice(0, 500)
    if (!company || !contact) {
      throw new BadRequestException('请填写公司名称与联系方式')
    }
    await this.audit.log({
      tenantId, userId,
      action: 'ENTERPRISE_LEAD',
      resource: 'enterprise_lead',
      detail: { company, teamSize, contact, note },
    })
    return { ok: true, message: '已收到咨询，演示环境将由专人（模拟）与你联系' }
  }

  // ── 内部：购买资格 / 权益生效补丁 ──────────────────────────────────────────

  private assertPurchasable(tenant: Tenant, item: CheckoutItemDef) {
    if (tenant.plan === 'ENTERPRISE') {
      throw new BadRequestException('企业版为定制套餐，请联系商务开通')
    }
    switch (item.item) {
      case 'PERSONAL_MONTHLY':
      case 'PERSONAL_YEARLY':
        if (tenant.workspaceType === 'TEAM') {
          throw new BadRequestException('团队空间无需购买个人版')
        }
        return
      case 'TEAM_MONTHLY':
        if (tenant.workspaceType === 'TEAM') {
          throw new BadRequestException('当前已是团队空间，席位增购请联系商务')
        }
        return
      case 'COUPON_PACK':
        // FREE/PERSONAL/TEAM 均可购券（ENTERPRISE 已在上面拦截）
        return
    }
  }

  private buildEffectPatch(
    tenant: Tenant,
    item: CheckoutItemDef,
    now: Date,
  ): Prisma.TenantUpdateInput {
    switch (item.kind) {
      case 'COUPON_PACK':
        return { couponBalance: { increment: item.couponQty! } }
      case 'SUBSCRIPTION':
      case 'UPGRADE': {
        // 续费从当前到期点续，避免剩余时长损失；新购/已过期从现在起算
        const activeSamePlan =
          tenant.plan === item.targetPlan &&
          tenant.planExpiresAt &&
          tenant.planExpiresAt.getTime() > now.getTime()
        const base = activeSamePlan ? new Date(tenant.planExpiresAt!) : now
        const expiresAt =
          item.period === 'YEAR' ? this.addMonths(base, 12) : this.addMonths(base, 1)
        return {
          plan: item.targetPlan!,
          workspaceType: item.targetPlan === 'TEAM' ? 'TEAM' : 'PERSONAL',
          planExpiresAt: expiresAt,
          planUpdatedAt: now,
          cancelAtPeriodEnd: false,
        }
      }
    }
  }

  private effectSummary(item: CheckoutItemDef) {
    switch (item.kind) {
      case 'COUPON_PACK':
        return { couponBalanceIncreased: item.couponQty }
      case 'SUBSCRIPTION':
      case 'UPGRADE':
        return { plan: item.targetPlan, period: item.period }
    }
  }

  /** UTC 日历月加减（避免 DST 漂移；到期日为对应日 00:00 UTC 附近，演示可接受） */
  private addMonths(date: Date, months: number): Date {
    const d = new Date(date)
    d.setUTCMonth(d.getUTCMonth() + months)
    return d
  }

  // ── 序列化 ────────────────────────────────────────────────────────────────

  /** 可读订单号：WM + yyyyMMdd + cuid 后 6 位（演示用，非强唯一展示号） */
  private orderNo(id: string, at: Date): string {
    const y = at.getUTCFullYear()
    const m = String(at.getUTCMonth() + 1).padStart(2, '0')
    const d = String(at.getUTCDate()).padStart(2, '0')
    return `WM${y}${m}${d}${id.replace(/[^a-z0-9]/gi, '').slice(-6).toUpperCase()}`
  }

  serialize(order: {
    id: string
    kind: string
    period: string | null
    targetPlan: string | null
    couponQty: number | null
    amountFen: number
    status: string
    createdAt: Date
    paidAt: Date | null
  }) {
    return {
      id: order.id,
      orderNo: this.orderNo(order.id, order.paidAt ?? order.createdAt),
      item: this.toItemCode(order.kind, order.targetPlan, order.period),
      kind: order.kind,
      period: order.period,
      targetPlan: order.targetPlan,
      couponQty: order.couponQty,
      amountFen: order.amountFen,
      amountYuan: (order.amountFen / 100).toFixed(2),
      status: order.status,
      createdAt: order.createdAt,
      paidAt: order.paidAt,
    }
  }

  private toItemCode(kind: string, targetPlan: string | null, period: string | null): CheckoutItem | null {
    if (kind === 'COUPON_PACK') return 'COUPON_PACK'
    if (targetPlan === 'PERSONAL') return period === 'YEAR' ? 'PERSONAL_YEARLY' : 'PERSONAL_MONTHLY'
    if (targetPlan === 'TEAM') return 'TEAM_MONTHLY'
    return null
  }
}
