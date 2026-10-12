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
import { MailerService } from '../auth/mailer.service.js'
import { EntitlementsService } from './entitlements.service.js'
import { getCheckoutItem, type CheckoutItem, type CheckoutItemDef } from './plans.config.js'
import { config as appConfig } from '../config/index.js'
import { Logger } from '@nestjs/common'

export type PayChannel = 'WECHAT' | 'ALIPAY'

/** 下单前的套餐/空间校验：不允许跨曲线乱买、企业版只走留资 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly mailer: MailerService,
  ) {}

  private readonly logger = new Logger('Orders')

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

  // ── 转账支付（人工确认模式）：用户提交转账单号 → 超管确认到账开通 ──────

  /** 收款信息（收款码 URL 等管理员配置，展示在收银台转账页签） */
  getPaymentInfo() {
    return {
      qrcodeUrl: appConfig.billing.paymentQrcodeUrl || null,
      note: '转账后请复制转账单号（微信/支付宝账单中的转账记录单号）填入下方提交，管理员确认到账后权益自动开通。',
    }
  }

  /** 提交转账订单：创建 PENDING 订单并记录渠道与转账单号，等待平台超管确认 */
  async createTransferOrder(
    tenantId: string,
    userId: string,
    body: { item?: string; channel?: string; transferNo?: string },
  ) {
    const item = getCheckoutItem((body.item || '').toUpperCase())
    if (!item) throw new BadRequestException('未知商品')
    const channel = ['WECHAT', 'ALIPAY', 'BANK'].includes((body.channel || '').toUpperCase())
      ? (body.channel || '').toUpperCase()
      : null
    if (!channel) throw new BadRequestException('请选择转账渠道（微信 / 支付宝 / 银行）')
    const transferNo = (body.transferNo || '').trim().slice(0, 100)
    if (!transferNo) throw new BadRequestException('请填写转账单号')

    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.assertPurchasable(tenant, item)

    // 防重复提交：同租户存在同单号的待确认订单时拒绝
    const dup = await this.db.order.findFirst({
      where: { tenantId, transferNo, status: 'PENDING' },
      select: { id: true },
    })
    if (dup) throw new ConflictException('该转账单号已提交，正在等待管理员确认')

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
        payChannel: channel,
        transferNo,
      },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'TRANSFER_ORDER_SUBMIT',
      resource: 'order',
      resourceId: order.id,
      detail: { item: item.item, channel, transferNo, amountFen: item.amountFen },
    })
    // 服务端埋点：转账单提交（漏斗：paywall → 转账提交 → 确认开通）
    await this.db.analyticsEvent.create({
      data: { tenantId, userId, type: 'transfer_submitted', props: { item: item.item, channel } },
    }).catch(() => {})

    return { order: this.serialize(order), message: '已提交，管理员确认到账后权益自动开通' }
  }

  /** 平台超管：待确认转账订单列表（含租户信息） */
  async listTransferOrders(status: string) {
    const st = ['PENDING', 'PAID', 'CANCELLED'].includes(status) ? status : 'PENDING'
    const orders = await this.db.order.findMany({
      where: { status: st as any, transferNo: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        tenant: { select: { name: true, plan: true } },
        createdBy: { select: { username: true, displayName: true, email: true } },
      },
    })
    return {
      orders: orders.map((o) => ({
        ...this.serialize(o),
        payChannel: o.payChannel,
        transferNo: o.transferNo,
        rejectReason: o.rejectReason,
        confirmedAt: o.confirmedAt,
        tenantName: o.tenant?.name ?? '-',
        tenantPlan: o.tenant?.plan ?? '-',
        submitter: o.createdBy
          ? `${o.createdBy.displayName || o.createdBy.username}（${o.createdBy.email || '无邮箱'}）`
          : '-',
      })),
    }
  }

  /** 平台超管：确认到账（PENDING → PAID，事务内应用权益，与模拟支付同一套生效逻辑） */
  async confirmTransferOrder(orderId: string, adminName: string) {
    const order = await this.db.order.findUnique({ where: { id: orderId } })
    if (!order) throw new NotFoundException('订单不存在')
    if (order.status !== 'PENDING') throw new ConflictException('订单已处理，请刷新列表')

    const item = getCheckoutItem(
      order.kind === 'COUPON_PACK'
        ? 'COUPON_PACK'
        : `${order.targetPlan}_${order.period === 'YEAR' ? 'YEARLY' : 'MONTHLY'}`,
    )
    if (!item) throw new BadRequestException('订单商品信息无效')

    const now = new Date()
    const paid = await this.db.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING' },
        data: { status: 'PAID', paidAt: now, confirmedAt: now },
      })
      if (claimed.count !== 1) throw new ConflictException('订单状态已变更，请刷新后重试')

      const tenant = await tx.tenant.findUnique({ where: { id: order.tenantId } })
      if (!tenant) throw new NotFoundException('工作空间不存在')
      const tenantPatch = this.buildEffectPatch(tenant, item, now)
      await tx.tenant.update({ where: { id: order.tenantId }, data: tenantPatch })
      return tx.order.findUniqueOrThrow({ where: { id: order.id } })
    })

    await this.audit.log({
      tenantId: order.tenantId, userId: null,
      action: 'TRANSFER_ORDER_CONFIRM',
      resource: 'order',
      resourceId: order.id,
      detail: {
        orderNo: this.orderNo(order.id, now),
        item: item.item,
        amountFen: order.amountFen,
        transferNo: order.transferNo,
        confirmedBy: adminName,
        effect: this.effectSummary(item),
      },
    })
    this.logger.log(`transfer order confirmed by ${adminName}: ${order.id} (${item.item})`)
    // 服务端埋点：订单确认开通（转化终点）
    await this.db.analyticsEvent.create({
      data: {
        tenantId: order.tenantId, userId: order.createdById,
        type: 'order_confirmed', props: { item: item.item, amountFen: order.amountFen },
      },
    }).catch(() => {})

    const entitlement = await this.entitlements.getEntitlementSnapshot(order.tenantId)
    return { order: this.serialize(paid), entitlement }
  }

  /** 平台超管：驳回转账订单（PENDING → CANCELLED，记录驳回原因） */
  async rejectTransferOrder(orderId: string, adminName: string, reason: string) {
    const order = await this.db.order.findUnique({ where: { id: orderId } })
    if (!order) throw new NotFoundException('订单不存在')
    if (order.status !== 'PENDING') throw new ConflictException('订单已处理，请刷新列表')
    const trimmed = (reason || '').trim().slice(0, 500)
    if (!trimmed) throw new BadRequestException('请填写驳回原因')

    await this.db.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', rejectReason: trimmed, confirmedAt: new Date() },
    })
    await this.audit.log({
      tenantId: order.tenantId, userId: null,
      action: 'TRANSFER_ORDER_REJECT',
      resource: 'order',
      resourceId: order.id,
      detail: { transferNo: order.transferNo, reason: trimmed, rejectedBy: adminName },
    })
    return { success: true }
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

  // ── 企业版留资（ENTERPRISE 定制 / 席位增购咨询，审计落库 + 邮件通知）──────────
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
    this.sendLeadNotifyMail(tenantId, userId, { company, teamSize, contact, note })
    return { ok: true, message: '已收到咨询，我们将尽快与你联系' }
  }

  /** 留资通知邮件（fire-and-forget，失败仅记日志不阻断提交） */
  private sendLeadNotifyMail(
    tenantId: string,
    userId: string,
    lead: { company: string; teamSize: string; contact: string; note: string },
  ) {
    const to = appConfig.mailer.leadNotifyEmail
    if (!to) return
    void (async () => {
      const [tenant, user] = await Promise.all([
        this.db.tenant.findUnique({ where: { id: tenantId }, select: { name: true, plan: true } }),
        this.db.user.findUnique({ where: { id: userId }, select: { displayName: true, username: true, email: true } }),
      ])
      const lines = [
        `收到一条新的商务咨询（企业版/席位增购留资），信息如下：`,
        ``,
        `公司名称：${lead.company}`,
        `团队规模：${lead.teamSize || '未填写'}`,
        `联系方式：${lead.contact}`,
        `咨询备注：${lead.note || '无'}`,
        ``,
        `── 提交环境 ──`,
        `提交人：${user?.displayName || user?.username || '未知'}（${user?.email || '无邮箱'}）`,
        `所属空间：${tenant?.name || tenantId}（当前套餐：${tenant?.plan || '-'}）`,
        `提交时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ]
      await this.mailer.send({
        to,
        subject: '【ClauseMind】新商务咨询 - 企业版开通意向',
        text: lines.join('\n'),
      })
    })().catch((err) => this.logger.warn(`留资通知邮件发送失败：${(err as Error).message}`))
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
    payChannel?: string | null
    transferNo?: string | null
    rejectReason?: string | null
    confirmedAt?: Date | null
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
      ...(order.payChannel !== undefined && { payChannel: order.payChannel }),
      ...(order.transferNo !== undefined && { transferNo: order.transferNo }),
      ...(order.rejectReason !== undefined && { rejectReason: order.rejectReason }),
      ...(order.confirmedAt !== undefined && { confirmedAt: order.confirmedAt }),
    }
  }

  private toItemCode(kind: string, targetPlan: string | null, period: string | null): CheckoutItem | null {
    if (kind === 'COUPON_PACK') return 'COUPON_PACK'
    if (targetPlan === 'PERSONAL') return period === 'YEAR' ? 'PERSONAL_YEARLY' : 'PERSONAL_MONTHLY'
    if (targetPlan === 'TEAM') return 'TEAM_MONTHLY'
    return null
  }
}
