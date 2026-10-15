// server/src/feedback/feedback.service.ts
// 建议反馈模块（个人版/企业版登录用户均可提交）：
//   入参校验 → 每用户每日提交条数限制 → 落库留底 → 异步邮件通知平台（失败仅记日志）
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { MailerService } from '../auth/mailer.service.js'
import { config as appConfig } from '../config/index.js'

/** 建议分类（存库用编码，与前端 Select value 对齐） */
const CATEGORIES = ['FEATURE', 'BUG', 'EXPERIENCE', 'OTHER'] as const
const CATEGORY_LABELS: Record<(typeof CATEGORIES)[number], string> = {
  FEATURE: '功能建议',
  BUG: '问题反馈',
  EXPERIENCE: '体验优化',
  OTHER: '其他',
}

const CONTENT_MIN = 5
const CONTENT_MAX = 1000
const CONTACT_MAX = 100
/** 单用户每日最多提交条数，防止接口被刷导致通知邮箱轰炸 */
const DAILY_LIMIT = 5

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger('Feedback')

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
  ) {}

  async create(tenantId: string | null, userId: string, dto: {
    category?: string
    content?: string
    contact?: string
  }) {
    if (!tenantId) throw new ForbiddenException('当前账号不支持提交建议')

    const category = ((dto.category ?? '').trim().toUpperCase() || 'OTHER') as string
    if (!CATEGORIES.includes(category as any)) {
      throw new BadRequestException('建议类型不合法')
    }
    const content = (dto.content ?? '').trim()
    if (content.length < CONTENT_MIN) {
      throw new BadRequestException(`请填写建议内容（至少 ${CONTENT_MIN} 个字）`)
    }
    if (content.length > CONTENT_MAX) {
      throw new BadRequestException(`建议内容最多 ${CONTENT_MAX} 个字`)
    }
    const contact = (dto.contact ?? '').trim()
    if (contact.length > CONTACT_MAX) {
      throw new BadRequestException(`联系方式最多 ${CONTACT_MAX} 个字`)
    }

    // 每用户每日限频（按服务器本地自然日）
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const todayCount = await this.db.feedbackEntry.count({
      where: { userId, createdAt: { gte: dayStart } },
    })
    if (todayCount >= DAILY_LIMIT) {
      throw new BadRequestException(`今日提交已达上限（${DAILY_LIMIT} 条），请明天再来`)
    }

    const entry = await this.db.feedbackEntry.create({
      data: {
        tenantId,
        userId,
        category,
        content,
        contact: contact || null,
      },
      select: { id: true, category: true, createdAt: true },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'FEEDBACK_CREATE',
      resource: 'feedback_entry',
      resourceId: entry.id,
      detail: { category },
    })

    this.sendNotifyMail(tenantId, userId, { category, content, contact })
    return { ok: true, id: entry.id }
  }

  /** 通知邮件（fire-and-forget，发送失败不影响提交结果，库里仍有留底） */
  private sendNotifyMail(
    tenantId: string,
    userId: string,
    feedback: { category: string; content: string; contact: string },
  ) {
    const to = appConfig.mailer.feedbackNotifyEmail
    if (!to) return
    void (async () => {
      const [tenant, user] = await Promise.all([
        this.db.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true, plan: true, workspaceType: true },
        }),
        this.db.user.findUnique({
          where: { id: userId },
          select: { displayName: true, username: true, email: true },
        }),
      ])
      const lines = [
        `收到一条新的用户建议反馈，信息如下：`,
        ``,
        `类型：${CATEGORY_LABELS[feedback.category as keyof typeof CATEGORY_LABELS] ?? feedback.category}`,
        `内容：`,
        feedback.content,
        ``,
        `联系方式：${feedback.contact || '未填写'}`,
        ``,
        `── 提交人信息 ──`,
        `提交人：${user?.displayName || user?.username || '未知'}（${user?.email || '无邮箱'}）`,
        `所属空间：${tenant?.name || tenantId}（${tenant?.workspaceType === 'TEAM' ? '企业版' : '个人版'}，套餐：${tenant?.plan || '-'}）`,
        `提交时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ]
      await this.mailer.send({
        to,
        subject: `【ClauseMind】新建议反馈 - ${CATEGORY_LABELS[feedback.category as keyof typeof CATEGORY_LABELS] ?? '其他'}`,
        text: lines.join('\n'),
      }).then((info) => {
        if (info?.messageId) {
          this.logger.log(`建议反馈通知邮件已发送 → ${to}（messageId=${info.messageId}）`)
        }
      })
    })().catch((err) => this.logger.warn(`建议反馈通知邮件发送失败：${(err as Error).message}`))
  }
}
