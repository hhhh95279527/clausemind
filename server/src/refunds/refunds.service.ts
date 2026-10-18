// server/src/refunds/refunds.service.ts
// 退款工单服务：表单申请 → AI 客服对话（可转人工）→ 平台超管处理。
// 核心规则：
//   - 每笔 PAID 订单仅允许一次退款申请；同租户 30 天内已有 ≥2 次申请 → 新申请直接进人工队列
//   - AI 客服：带订单上下文开场；政策 = 未使用可秒退引导转人工快速确认 / 大量使用则挽留；
//     命中升级关键词（转人工/投诉/诉讼等）或 LLM 判定超政策 → 转人工；无 Key 或 AI 异常 → 自动降级人工
//   - 超管同意 = 事务内：工单 RESOLVED + 订单标 REFUNDED + 权益立即降级（订阅降 FREE / 券包扣券）+ audit 留痕
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import fs from 'fs/promises'
import { z } from 'zod'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { TraceService } from '../observability/trace.service.js'
import { config as appConfig, isValidAiKey } from '../config/index.js'
import { createChatModel } from '../services/model.js'

export const REFUND_REASONS = ['MISBUY', 'DUPLICATE', 'NOT_AS_EXPECTED', 'OTHER'] as const
type RefundReason = (typeof REFUND_REASONS)[number]

const REASON_LABELS: Record<RefundReason, string> = {
  MISBUY: '误购',
  DUPLICATE: '重复扣款',
  NOT_AS_EXPECTED: '效果不符预期',
  OTHER: '其他',
}

/** 商品编码 → 展示名（与 orders.service.toItemCode 对齐） */
export const REFUND_ITEM_LABELS: Record<string, string> = {
  PERSONAL_MONTHLY: '个人版 · 月付',
  PERSONAL_YEARLY: '个人版 · 年付',
  COUPON_PACK: '深度审查券包 ×10',
  TEAM_MONTHLY: '团队版 · 月付',
}

function orderItemCode(order: { kind: string; targetPlan: string | null; period: string | null }): string {
  if (order.kind === 'COUPON_PACK') return 'COUPON_PACK'
  if (order.targetPlan === 'PERSONAL') return order.period === 'YEAR' ? 'PERSONAL_YEARLY' : 'PERSONAL_MONTHLY'
  if (order.targetPlan === 'TEAM') return 'TEAM_MONTHLY'
  return order.kind
}

// ── 策略常量 ──────────────────────────────────────────────────────────────
const MAX_TEXT_CHARS = 1000
const RECENT_REFUND_WINDOW_DAYS = 30
/** 30 天内已有 ≥ N 次申请（不含本次）→ 新申请直接转人工，防滥用 */
const RECENT_REFUND_AGENT_THRESHOLD = 2
/** 命中即跳过 AI 直接转人工（涉诉/情绪/明确要求人工） */
const ESCALATE_KEYWORDS = [
  '转人工', '人工客服', '真人客服', '投诉', '举报', '12315', '消协', '工商局',
  '律师', '法院', '起诉', '诉讼', '仲裁', '报警', '监管', '曝光', '媒体',
]

// AI 结构化输出：回复 + 是否转人工
const AiReplySchema = z.object({
  reply: z.string().min(1).max(700),
  escalate: z.boolean(),
  escalate_reason: z.string().max(200).nullable(),
})

interface AttachmentMeta { name: string; size: number; path: string }

@Injectable()
export class RefundsService {
  private readonly logger = new Logger('Refunds')

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
    private readonly tracer: TraceService,
  ) {}

  // ── 用户端：创建申请（multipart，附件已由 multer 落盘）───────────────────
  async create(
    tenantId: string,
    userId: string,
    body: {
      orderId?: string
      reason?: string
      description?: string
      refundChannel?: string
      refundAccount?: string
      refundAccountName?: string
    },
    files?: Express.Multer.File[],
  ) {
    const orderId = (body.orderId || '').trim()
    const reason = (body.reason || '').toUpperCase() as RefundReason
    if (!REFUND_REASONS.includes(reason)) throw new BadRequestException('请选择退款原因')
    const description = (body.description || '').trim().slice(0, MAX_TEXT_CHARS)

    const order = await this.db.order.findFirst({ where: { id: orderId, tenantId } })
    if (!order) throw new NotFoundException('订单不存在')
    if (order.status !== 'PAID') throw new BadRequestException('仅已支付订单可申请退款')
    const dup = await this.db.refundRequest.findFirst({ where: { orderId: order.id }, select: { id: true } })
    if (dup) throw new ConflictException('该订单已申请过退款，请勿重复提交')

    // 真实订单（转账支付）必须提供收款信息，供超管线下回款；模拟订单跳过
    const isRealOrder = !!order.transferNo
    const refundChannel = ['WECHAT', 'ALIPAY', 'BANK'].includes((body.refundChannel || '').toUpperCase())
      ? (body.refundChannel || '').toUpperCase()
      : null
    const refundAccount = (body.refundAccount || '').trim().slice(0, 100)
    const refundAccountName = (body.refundAccountName || '').trim().slice(0, 50)
    if (isRealOrder) {
      if (!refundChannel) throw new BadRequestException('请选择退款收款渠道（微信 / 支付宝 / 银行）')
      if (!refundAccount) throw new BadRequestException('请填写退款收款账号（微信号 / 手机号 / 银行卡号）')
      if (!refundAccountName) throw new BadRequestException('请填写收款人姓名')
    }

    // 附件：≤5 份、单份 ≤10MB（multer 已按上限拦截，这里防御性校验份数）
    const attachments: AttachmentMeta[] = (files || []).slice(0, 5).map((f) => ({
      name: f.originalname.slice(0, 255),
      size: f.size,
      path: f.path,
    }))

    // 防滥用：30 天内已有多笔申请 → 本次直接进人工队列（AI 客服不再接待）
    const recentCount = await this.db.refundRequest.count({
      where: {
        tenantId,
        createdAt: { gte: new Date(Date.now() - RECENT_REFUND_WINDOW_DAYS * 86400_000) },
      },
    })
    const aiEnabled = this.aiEnabled()
    const forceAgent = recentCount >= RECENT_REFUND_AGENT_THRESHOLD

    const request = await this.db.refundRequest.create({
      data: {
        tenantId,
        userId,
        orderId: order.id,
        amountFen: order.amountFen,
        reason,
        description: description || null,
        attachments: attachments as any,
        refundChannel: isRealOrder ? refundChannel : null,
        refundAccount: isRealOrder ? refundAccount : null,
        refundAccountName: isRealOrder ? refundAccountName : null,
        status: aiEnabled && !forceAgent ? 'CHAT' : 'AGENT',
      },
    })

    // 开场消息：AI 接待 → 带订单上下文的开场；人工队列 → SYSTEM 说明
    if (request.status === 'CHAT') {
      await this.db.refundMessage.create({
        data: { requestId: request.id, sender: 'AI', content: this.buildOpening(order, reason) },
      })
    } else {
      await this.db.refundMessage.create({
        data: {
          requestId: request.id,
          sender: 'SYSTEM',
          content: aiEnabled
            ? '检测到您近期多次申请退款，为保障处理质量，已为您转接人工客服，请稍候。'
            : '已提交人工客服处理，请稍候，客服会尽快回复。',
          meta: { cause: aiEnabled ? 'REPEAT_REQUEST' : 'AI_UNAVAILABLE' },
        },
      })
    }

    await this.audit.log({
      tenantId, userId,
      action: 'REFUND_CREATE',
      resource: 'refund_request',
      resourceId: request.id,
      detail: { orderId: order.id, reason, amountFen: order.amountFen, attachments: attachments.length },
    })
    this.logger.log(`refund request created: ${request.id} (order=${order.id}, status=${request.status})`)

    return this.detailForUser(tenantId, userId, request.id)
  }

  /** 我的退款申请（新→旧） */
  async listMine(tenantId: string, userId: string) {
    const requests = await this.db.refundRequest.findMany({
      where: { tenantId, userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { order: { select: { id: true, kind: true, targetPlan: true, period: true, status: true, paidAt: true } } },
    })
    return { requests: requests.map((r) => this.serialize(r)) }
  }

  /** 用户端详情（跨租户/非本人统一 404） */
  async detailForUser(tenantId: string, userId: string, id: string) {
    const request = await this.db.refundRequest.findFirst({
      where: { id, tenantId, userId },
      include: { order: { select: { id: true, kind: true, targetPlan: true, period: true, status: true, paidAt: true } } },
    })
    if (!request) throw new NotFoundException('退款工单不存在')
    const messages = await this.db.refundMessage.findMany({
      where: { requestId: id },
      orderBy: { createdAt: 'asc' },
    })
    return { request: this.serialize(request), messages: messages.map((m) => this.serializeMessage(m)) }
  }

  // ── 用户端：发消息（AI 接待或人工等待）────────────────────────────────────
  async sendUserMessage(tenantId: string, userId: string, id: string, contentRaw: string) {
    const content = (contentRaw || '').trim().slice(0, MAX_TEXT_CHARS)
    if (!content) throw new BadRequestException('请输入内容')
    const request = await this.db.refundRequest.findFirst({ where: { id, tenantId, userId } })
    if (!request) throw new NotFoundException('退款工单不存在')
    if (request.status === 'RESOLVED') throw new ConflictException('工单已处理完毕，无法继续留言')

    await this.db.refundMessage.create({
      data: { requestId: id, sender: 'USER', content },
    })

    if (request.status === 'CHAT') {
      await this.handleAiTurn(request.id, content)
    }
    return this.detailForUser(tenantId, userId, id)
  }

  /** 用户主动转人工：CHAT → AGENT */
  async escalate(tenantId: string, userId: string, id: string) {
    const request = await this.db.refundRequest.findFirst({ where: { id, tenantId, userId } })
    if (!request) throw new NotFoundException('退款工单不存在')
    if (request.status === 'RESOLVED') throw new ConflictException('工单已处理完毕')
    if (request.status === 'AGENT') throw new ConflictException('已是人工客服处理中，请耐心等待')
    await this.toAgent(id, 'USER_REQUEST', '已为您转接人工客服，请稍候。')
    return this.detailForUser(tenantId, userId, id)
  }

  // ── 用户端：下载自己的附件 ────────────────────────────────────────────────
  async getUserAttachment(tenantId: string, userId: string, id: string, index: string) {
    const request = await this.db.refundRequest.findFirst({ where: { id, tenantId, userId } })
    if (!request) throw new NotFoundException('退款工单不存在')
    return this.resolveAttachment(request.attachments as unknown as AttachmentMeta[], index)
  }

  // ── 平台超管端 ────────────────────────────────────────────────────────────

  /** 退款工单列表（含租户/申请人/订单摘要） */
  async listForPlatform(status?: string) {
    const where = status && ['CHAT', 'AGENT', 'RESOLVED'].includes(status) ? { status: status as any } : {}
    const requests = await this.db.refundRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        tenant: { select: { name: true, plan: true } },
        user: { select: { username: true, displayName: true, email: true } },
        order: { select: { id: true, kind: true, targetPlan: true, period: true, status: true, paidAt: true } },
      },
    })
    return {
      requests: requests.map((r) => ({
        ...this.serialize(r),
        tenantName: r.tenant?.name ?? '-',
        tenantPlan: r.tenant?.plan ?? '-',
        requester: r.user ? `${r.user.displayName || r.user.username}（${r.user.email || '无邮箱'}）` : '-',
      })),
    }
  }

  async detailForPlatform(id: string) {
    const request = await this.db.refundRequest.findUnique({
      where: { id },
      include: {
        tenant: { select: { name: true, plan: true } },
        user: { select: { username: true, displayName: true, email: true } },
        order: { select: { id: true, kind: true, targetPlan: true, period: true, status: true, paidAt: true } },
      },
    })
    if (!request) throw new NotFoundException('退款工单不存在')
    const messages = await this.db.refundMessage.findMany({
      where: { requestId: id },
      orderBy: { createdAt: 'asc' },
    })
    const entitlement = await this.entitlements.getEntitlementSnapshot(request.tenantId)
    return {
      request: {
        ...this.serialize(request),
        tenantName: request.tenant?.name ?? '-',
        requester: request.user ? `${request.user.displayName || request.user.username}（${request.user.email || '无邮箱'}）` : '-',
      },
      messages: messages.map((m) => this.serializeMessage(m)),
      entitlement,
    }
  }

  /** 人工客服回复：CHAT 工单自动切入 AGENT（人工已介入） */
  async agentReply(id: string, adminName: string, contentRaw: string) {
    const content = (contentRaw || '').trim().slice(0, MAX_TEXT_CHARS)
    if (!content) throw new BadRequestException('请输入回复内容')
    const request = await this.db.refundRequest.findUnique({ where: { id } })
    if (!request) throw new NotFoundException('退款工单不存在')
    if (request.status === 'RESOLVED') throw new ConflictException('工单已处理完毕，无法继续回复')

    if (request.status === 'CHAT') {
      await this.db.refundRequest.update({ where: { id }, data: { status: 'AGENT' } })
      await this.db.refundMessage.create({
        data: {
          requestId: id, sender: 'SYSTEM',
          content: '人工客服已接入，将为您处理本次退款申请。',
          meta: { cause: 'AGENT_JOINED' },
        },
      })
    }
    await this.db.refundMessage.create({ data: { requestId: id, sender: 'AGENT', content } })
    await this.audit.log({
      tenantId: request.tenantId, userId: null,
      action: 'REFUND_AGENT_REPLY',
      resource: 'refund_request',
      resourceId: id,
      detail: { by: adminName },
    })
    return this.detailForPlatform(id)
  }

  /**
   * 处理工单（终态裁决）。
   * APPROVE：事务内 工单 RESOLVED + 订单 REFUNDED + 权益降级（订阅降 FREE / 券包扣券，余额下限 0）。
   *          真实订单（transferNo != null）必须填回款转账单号，作为资金凭证。
   * REJECT：工单 RESOLVED，订单保持 PAID。
   */
  async resolve(id: string, adminName: string, decision: 'APPROVE' | 'REJECT', noteRaw?: string, refundTransferNoRaw?: string) {
    const note = (noteRaw || '').trim().slice(0, 500)
    if (decision === 'REJECT' && !note) throw new BadRequestException('拒绝时请填写原因')
    const request = await this.db.refundRequest.findUnique({ where: { id } })
    if (!request) throw new NotFoundException('退款工单不存在')
    if (request.status === 'RESOLVED') throw new ConflictException('工单已处理，请刷新列表')

    const now = new Date()
    if (decision === 'REJECT') {
      const claimed = await this.db.refundRequest.updateMany({
        where: { id, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', resolution: 'REJECTED', resolvedAt: now },
      })
      if (claimed.count !== 1) throw new ConflictException('工单状态已变更，请刷新')
      await this.db.refundMessage.create({
        data: {
          requestId: id, sender: 'SYSTEM',
          content: `客服已处理您的退款申请：很抱歉本次未通过退款审核。原因：${note}`,
          meta: { resolution: 'REJECTED' },
        },
      })
      await this.audit.log({
        tenantId: request.tenantId, userId: null,
        action: 'REFUND_REJECTED',
        resource: 'refund_request',
        resourceId: id,
        detail: { by: adminName, reason: note, amountFen: request.amountFen },
      })
      return this.detailForPlatform(id)
    }

    // 同意退款：订单 + 工单 + 权益同事务生效
    const order = await this.db.order.findUnique({ where: { id: request.orderId } })
    if (!order) throw new NotFoundException('原订单不存在')

    // 真实订单必须填回款转账单号，作为资金凭证
    const isRealOrder = !!order.transferNo
    const refundTransferNo = (refundTransferNoRaw || '').trim().slice(0, 100)
    if (isRealOrder && !refundTransferNo) {
      throw new BadRequestException('真实转账订单退款：请填写回款转账单号（微信/支付宝/银行转账记录单号），证明资金已退回用户')
    }

    await this.db.$transaction(async (tx) => {
      const claimed = await tx.refundRequest.updateMany({
        where: { id, status: { not: 'RESOLVED' } },
        data: {
          status: 'RESOLVED',
          resolution: 'APPROVED',
          resolvedAt: now,
          ...(isRealOrder ? { refundTransferNo } : {}),
        },
      })
      if (claimed.count !== 1) throw new ConflictException('工单状态已变更，请刷新')

      await tx.order.update({
        where: { id: order.id },
        data: { status: 'REFUNDED' },
      })

      // 权益立即降级：订阅 → FREE；券包 → 扣减券（余额下限 0，防超退）
      if (order.kind === 'COUPON_PACK') {
        const tenant = await tx.tenant.findUnique({ where: { id: order.tenantId } })
        if (tenant) {
          await tx.tenant.update({
            where: { id: order.tenantId },
            data: { couponBalance: Math.max(0, tenant.couponBalance - (order.couponQty ?? 0)) },
          })
        }
      } else {
        await tx.tenant.update({
          where: { id: order.tenantId },
          data: {
            plan: 'FREE',
            workspaceType: 'PERSONAL',
            planExpiresAt: null,
            cancelAtPeriodEnd: false,
          },
        })
      }

      // 通知消息：模拟单即时到账；真实单展示回款渠道/账号/单号
      const amount = (request.amountFen / 100).toFixed(2)
      const channelLabel = order.payChannel === 'WECHAT' ? '微信' : order.payChannel === 'ALIPAY' ? '支付宝' : '银行'
      const maskedAccount = this.maskAccount(request.refundAccount)
      const content = isRealOrder
        ? `退款已同意：¥${amount} 已通过 ${channelLabel} 转账退回至您提供的收款账户（${maskedAccount}），回款转账单号：${refundTransferNo}。相关权益已同步调整。`
        : `退款已同意：¥${amount} 将按原支付方式退回（演示环境即时到账），相关权益已同步调整。`
      await tx.refundMessage.create({
        data: {
          requestId: id, sender: 'SYSTEM',
          content,
          meta: { resolution: 'APPROVED', ...(isRealOrder ? { refundTransferNo, channelLabel } : {}) },
        },
      })
    })

    await this.audit.log({
      tenantId: order.tenantId, userId: null,
      action: 'REFUND_APPROVED',
      resource: 'refund_request',
      resourceId: id,
      detail: {
        by: adminName,
        orderId: order.id,
        amountFen: request.amountFen,
        kind: order.kind,
        ...(isRealOrder ? { refundTransferNo, channel: order.payChannel, refundAccount: request.refundAccount } : {}),
      },
    })
    this.logger.log(`refund approved: ${id} (order=${order.id}, real=${isRealOrder}, by=${adminName})`)
    return this.detailForPlatform(id)
  }

  /** 收款账号脱敏：保留前 2 位 + 后 2 位 */
  private maskAccount(account: string | null): string {
    if (!account) return '未提供'
    if (account.length <= 4) return account
    return `${account.slice(0, 2)}****${account.slice(-2)}`
  }

  /** 平台端下载附件 */
  async getPlatformAttachment(id: string, index: string) {
    const request = await this.db.refundRequest.findUnique({ where: { id } })
    if (!request) throw new NotFoundException('退款工单不存在')
    return this.resolveAttachment(request.attachments as unknown as AttachmentMeta[], index)
  }

  // ── AI 客服回合 ───────────────────────────────────────────────────────────

  /** 处理一轮 AI 对话：命中关键词直接升级；否则 LLM 回复（异常自动降级人工） */
  private async handleAiTurn(requestId: string, userText: string) {
    if (ESCALATE_KEYWORDS.some((k) => userText.includes(k))) {
      await this.toAgent(requestId, 'KEYWORD', '已为您转接人工客服，请稍候。')
      return
    }
    if (!this.aiEnabled()) {
      await this.toAgent(requestId, 'AI_UNAVAILABLE', 'AI 客服暂时不可用，已为您转接人工客服。')
      return
    }

    try {
      const request = await this.db.refundRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { order: { select: { kind: true, targetPlan: true, period: true, paidAt: true } } },
      })
      const history = await this.db.refundMessage.findMany({
        where: { requestId },
        orderBy: { createdAt: 'asc' },
        select: { sender: true, content: true },
      })
      const systemPrompt = await this.buildAiPrompt(request)
      const ai = await this.invokeAi(systemPrompt, history, userText, request.tenantId)

      if (ai.escalate) {
        const reason = (ai.escalate_reason || '').slice(0, 200) || '超出智能客服处理范围'
        await this.toAgent(requestId, 'AI_JUDGED', `${ai.reply}\n\n（已为您转接人工客服，原因：${reason}）`)
        return
      }
      await this.db.refundMessage.create({
        data: { requestId, sender: 'AI', content: ai.reply.slice(0, 2000) },
      })
    } catch (err) {
      this.logger.warn(`AI refund chat failed, fallback to agent: ${(err as Error).message}`)
      await this.toAgent(requestId, 'AI_ERROR', 'AI 客服暂时不可用，已为您转接人工客服，请稍候。').catch(() => {})
    }
  }

  /** 转人工：置 AGENT + SYSTEM 说明消息 */
  private async toAgent(requestId: string, cause: string, content: string) {
    await this.db.refundRequest.updateMany({
      where: { id: requestId, status: 'CHAT' },
      data: { status: 'AGENT' },
    })
    await this.db.refundMessage.create({
      data: { requestId, sender: 'SYSTEM', content, meta: { cause } },
    })
  }

  private aiEnabled(): boolean {
    return isValidAiKey(appConfig.ai.deepseekKey)
  }

  /** AI 开场白：带订单上下文（商品/金额/原因），引导描述问题或转人工 */
  private buildOpening(
    order: { amountFen: number; kind: string; targetPlan: string | null; period: string | null },
    reason: RefundReason,
  ): string {
    const code = orderItemCode(order)
    const item = REFUND_ITEM_LABELS[code] || code
    return [
      '您好，我是 ClauseMind 智能客服。',
      `已收到您的退款申请：订单「${item}」¥${(order.amountFen / 100).toFixed(2)}，原因：${REASON_LABELS[reason]}。`,
      '为了更快帮您解决，请简单描述一下遇到的情况；您也可以随时点击「转人工」由人工客服处理。',
    ].join('\n')
  }

  /** 订单上下文 + 租户用量 + 退款政策 system prompt */
  private async buildAiPrompt(
    request: { amountFen: number; reason: string; description: string | null } & {
      tenantId: string
      order: { kind: string; targetPlan: string | null; period: string | null; paidAt: Date | null }
    },
  ) {
    const code = orderItemCode(request.order)
    const item = REFUND_ITEM_LABELS[code] || code
    const amount = (request.amountFen / 100).toFixed(2)
    const snapshot = await this.entitlements.getEntitlementSnapshot(request.tenantId)
    return `你是 ClauseMind（AI 合同审查平台）的退款客服，正在与用户就退款申请对话。

【订单上下文】
- 商品：${item}
- 金额：¥${amount}
- 支付时间：${request.order.paidAt ? request.order.paidAt.toLocaleString('zh-CN', { hour12: false }) : '未知'}
- 用户选择的原因：${REASON_LABELS[request.reason as RefundReason] || request.reason}
- 用户补充说明：${request.description || '无'}
${snapshot ? `- 用户当前套餐：${snapshot.label}\n- 本月已用审查次数：${snapshot.usedReviews}\n- 深度券余额：${snapshot.couponBalance} 张` : ''}

【退款政策】
1. 若用户购买后基本未使用（本月审查次数为 0，或券包未使用）：告知其符合快速退款条件，建议点击「转人工」由人工客服快速确认到账；不要承诺具体到账时间。
2. 若用户已大量使用：按政策不支持无理由退款，语气友善地说明，并给出挽留方案：到期后取消订阅（不再续费）、赠送深度审查券补偿、或降级为免费版。安抚优先，不与用户争辩。
3. 用户坚持要求、诉求超出政策、情绪激动，或涉及投诉/监管/法律程序 → 输出 escalate=true 并简短安抚。
4. 只处理本退款工单相关问题；回复为中文、口语化、80 字以内，不使用 Markdown 列表。`
  }

  private async invokeAi(
    systemPrompt: string,
    history: { sender: string; content: string }[],
    userText: string,
    tenantId: string,
  ) {
    const model = createChatModel({ temperature: 0.3, streaming: false })
    const structured = model.withStructuredOutput(AiReplySchema, { method: 'jsonMode' })
    const recent = history.slice(-10)
    const messages: [string, string][] = [['system', systemPrompt]]
    for (const m of recent) {
      if (m.sender === 'USER') messages.push(['human', m.content])
      else if (m.sender === 'AI') messages.push(['ai', m.content])
      else messages.push(['ai', `[系统消息] ${m.content}`])
    }
    messages.push(['human', userText])

    const result = await this.tracer.run(
      { feature: 'refund_chat', name: '退款客服 AI 回复', tenantId, userId: null },
      async (handle) =>
        structured.invoke(messages, {
          callbacks: handle.callbacks,
          signal: AbortSignal.timeout(60_000),
        }),
    )
    const parsed = AiReplySchema.safeParse(result)
    if (!parsed.success) throw new Error('AI 回复结构不合法')
    return parsed.data
  }

  /** 附件定位：解析 JSON 元数据 → 路径（越界/失效即 404） */
  private async resolveAttachment(attachments: AttachmentMeta[], indexRaw: string) {
    const list = Array.isArray(attachments) ? attachments : []
    const idx = Number(indexRaw)
    if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
      throw new NotFoundException('附件不存在')
    }
    const att = list[idx]
    try {
      await fs.access(att.path)
    } catch {
      throw new NotFoundException('附件文件已失效')
    }
    return { filePath: att.path, fileName: att.name || `attachment-${idx + 1}` }
  }

  // ── 序列化 ────────────────────────────────────────────────────────────────

  private serialize(r: {
    id: string
    orderId: string
    amountFen: number
    reason: string
    description: string | null
    attachments: unknown
    refundChannel: string | null
    refundAccount: string | null
    refundAccountName: string | null
    refundTransferNo: string | null
    status: string
    resolution: string | null
    resolvedAt: Date | null
    createdAt: Date
    order?: { id: string; kind: string; targetPlan: string | null; period: string | null; status: string; paidAt: Date | null } | null
  }) {
    const itemCode = r.order ? orderItemCode(r.order) : null
    return {
      id: r.id,
      orderId: r.orderId,
      item: itemCode,
      itemLabel: itemCode ? REFUND_ITEM_LABELS[itemCode] || itemCode : '商品',
      orderStatus: r.order?.status ?? null,
      orderPaidAt: r.order?.paidAt ?? null,
      amountFen: r.amountFen,
      amountYuan: (r.amountFen / 100).toFixed(2),
      reason: r.reason,
      reasonLabel: REASON_LABELS[r.reason as RefundReason] || r.reason,
      description: r.description,
      attachments: (Array.isArray(r.attachments) ? (r.attachments as AttachmentMeta[]) : []).map((a, i) => ({
        index: i, name: a.name, size: a.size,
      })),
      refundChannel: r.refundChannel,
      refundAccount: r.refundAccount,
      refundAccountName: r.refundAccountName,
      refundTransferNo: r.refundTransferNo,
      status: r.status,
      resolution: r.resolution,
      resolvedAt: r.resolvedAt,
      createdAt: r.createdAt,
    }
  }

  private serializeMessage(m: { id: string; sender: string; content: string; meta: unknown; createdAt: Date }) {
    return {
      id: m.id,
      sender: m.sender,
      content: m.content,
      meta: m.meta ?? null,
      createdAt: m.createdAt,
    }
  }
}
