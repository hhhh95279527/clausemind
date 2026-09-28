// server/src/contract/contract.controller.ts
// 合同业务接口：上传/列表/详情 → 发起审查(SSE) → 待审列表 → 人工决策恢复 → 意见书
// 所有查询强制 tenantId 过滤；跨租户访问一律 404。
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get,
  NotFoundException, OnModuleInit, Param, Post, Req, Res,
} from '@nestjs/common'
import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { DatabaseService } from '../database/database.service.js'
import { TraceService } from '../observability/trace.service.js'
import { QuotaService } from '../observability/quota.service.js'
import { Roles } from '../auth/decorators/roles.decorator.js'
import { initSse } from '../utils/sse.js'
import { logger } from '../utils/logger.js'
import { assertRealFileType } from '../utils/file-guard.js'
import { ContractParseService } from './parsing/contract-parse.service.js'
import { OnboardingService } from './onboarding/onboarding.service.js'
import { ContractAssistantService } from './assistant/contract-assistant.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { PlanLimitException } from '../billing/plan-limit.exception.js'
import { FREE_RETENTION_DAYS, type ReviewScene } from '../billing/plans.config.js'
import { Prisma } from '@prisma/client'
import { setReviewDatabase, startReview, resumeReview, serializeRisk } from './review/review.agent.js'
import { buildOpinionDocx } from './review/report-docx.js'
import { StructuredService } from './review/structured.service.js'
import { AuditService } from '../audit/audit.service.js'
import { FeishuNotifyService } from '../services/feishu/feishu-notify.service.js'

const SCENES: ReviewScene[] = ['LABOR', 'LEASE', 'SERVICE', 'NDA', 'CUSTOM']

@Controller('api')
export class ContractController implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly parseService: ContractParseService,
    private readonly tracer: TraceService,
    private readonly quota: QuotaService,
    private readonly onboarding: OnboardingService,
    private readonly entitlements: EntitlementsService,
    private readonly assistant: ContractAssistantService,
    private readonly structured: StructuredService,
    private readonly audit: AuditService,
    private readonly feishu: FeishuNotifyService,
  ) {}

  onModuleInit() {
    setReviewDatabase(this.db)
    // multer diskStorage 不会自动建目录
    fs.mkdir('./uploads', { recursive: true }).catch(() => {})
  }

  /** 校验并归一化合同场景（缺省 LABOR，非法值 400） */
  private parseScene(raw: unknown): ReviewScene {
    const scene = (raw || 'LABOR') as ReviewScene
    if (!SCENES.includes(scene)) {
      throw new BadRequestException('合同类型不合法，支持：劳动 / 租赁 / 劳务 / NDA / 非标')
    }
    return scene
  }

  /** FREE 档合同建档即置 7 天保留期；付费档永久（升级后由 TTL job 按当前套餐二次判定） */
  private async buildCreateData(
    tenantId: string,
    userId: string,
    fields: Omit<Prisma.ContractUncheckedCreateInput, 'tenantId' | 'uploadedBy'>,
  ): Promise<Prisma.ContractUncheckedCreateInput> {
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    return {
      ...fields,
      tenantId,
      uploadedBy: userId,
      retainUntil: this.entitlements.isDeep(tenant.plan)
        ? null
        : new Date(Date.now() + FREE_RETENTION_DAYS * 86_400_000),
    }
  }

  // ── 上传合同文件（multipart：file + title + scene）────────────
  @Post('contracts/upload')
  async upload(@Req() req: Request, @Body() body: { title?: string; scene?: string }) {
    const file = (req as any).file as Express.Multer.File | undefined
    if (!file) throw new BadRequestException('请选择合同文件')

    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const ext = path.extname(file.originalname).toLowerCase()
    const scene = this.parseScene(body.scene)

    // magic number 校验：防改后缀伪造；不通过立即删除临时文件，不进解析队列
    try {
      await assertRealFileType(file.path, ext)
    } catch (e) {
      await fs.unlink(file.path).catch(() => {})
      throw e
    }

    const contract = await this.db.contract.create({
      data: await this.buildCreateData(tenantId, userId, {
        title: (body.title || file.originalname.replace(/\.[^.]+$/, '')).slice(0, 200),
        fileName: file.originalname,
        fileType: ext.slice(1) || 'txt',
        scene,
        status: 'UPLOADED' as const,
      }),
    })
    await this.parseService.enqueue(contract.id, file.path)
    logger.info('contract: uploaded', { contractId: contract.id, file: file.originalname, scene })
    return { contract }
  }

  // ── 直接粘贴合同文本 ─────────────────────────────────────────
  @Post('contracts/text')
  async uploadText(
    @Req() req: Request,
    @Body() body: { title?: string; content?: string; scene?: string },
  ) {
    if (!body.content?.trim()) throw new BadRequestException('合同内容不能为空')
    if (body.content.length > 200_000) throw new BadRequestException('合同文本过长（上限 20 万字），请改用文件上传')

    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const scene = this.parseScene(body.scene)
    await fs.mkdir('./uploads', { recursive: true })
    const tmpPath = `./uploads/contract_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
    await fs.writeFile(tmpPath, body.content, 'utf-8')

    const contract = await this.db.contract.create({
      data: await this.buildCreateData(tenantId, userId, {
        title: (body.title || `合同文本 ${new Date().toLocaleDateString('zh-CN')}`).slice(0, 200),
        fileName: '粘贴文本.txt',
        fileType: 'txt',
        scene,
        status: 'UPLOADED' as const,
      }),
    })
    await this.parseService.enqueue(contract.id, tmpPath)
    return { contract }
  }

  // ── 发起前预检：字数/场景/月额度（不扣券、不建任务）；前端据此弹付费墙 ──
  @Post('contracts/eligibility')
  async eligibility(@Req() req: Request, @Body() body: { charCount?: number; scene?: string; payWithCoupon?: boolean }) {
    const tenantId = (req as any).user.tenantId
    const charCount = Number(body.charCount) || 0
    const scene = this.parseScene(body.scene)
    const { deep } = await this.entitlements.assertStartReview(tenantId, {
      charCount,
      scene,
      payWithCoupon: !!body.payWithCoupon,
    })
    const snapshot = await this.entitlements.getEntitlementSnapshot(tenantId)
    return { allowed: true, deep, ...snapshot }
  }

  // ── 新手引导：体验示例合同（每租户限一次、不扣额度；FR-3）────────
  @Post('contracts/sample')
  async copySample(@Req() req: Request) {
    return this.onboarding.copySampleContract({
      userId: (req as any).user.userId,
      tenantId: (req as any).user.tenantId,
    })
  }

  // ── 合同列表（status 可选；含最近一次审查状态）─────────────────
  @Get('contracts')
  async list(@Req() req: Request) {
    const tenantId = (req as any).user.tenantId
    const params = new URL(req.url, 'http://x').searchParams
    const status = params.get('status')
    // reviewStatus：企业态列表筛选 PENDING(待审查) / WAITING_REVIEW(待审批) / APPROVED(已通过) / FAILED(解析失败或已驳回)
    const reviewStatus = params.get('reviewStatus')
    const contracts = await this.db.contract.findMany({
      where: {
        tenantId,
        ...(status ? { status: status as any } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        reviewTasks: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, isDeep: true, stats: true, createdAt: true, _count: { select: { risks: true } } },
        },
        _count: { select: { clauses: true } },
      },
    })

    // 最近一次审查任务中 Playbook（公司红线/偏好）命中数——用于列表紫徽标
    const taskIds = contracts.map((c) => c.reviewTasks[0]?.id).filter(Boolean)
    const playbookGroups = taskIds.length
      ? await this.db.risk.groupBy({
        by: ['reviewTaskId'],
        where: { reviewTaskId: { in: taskIds }, detectedBy: 'PLAYBOOK' },
        _count: { _all: true },
      })
      : []
    const playbookCountMap = new Map(playbookGroups.map((g) => [g.reviewTaskId, g._count._all]))

    let items = contracts.map((c) => ({
      id: c.id,
      title: c.title,
      fileName: c.fileName,
      status: c.status,
      progress: c.progress,
      parseError: c.parseError,
      fileType: c.fileType,
      scene: c.scene,
      charCount: c.charCount,
      clausesCount: c.clausesCount,
      retainUntil: c.retainUntil,
      createdAt: c.createdAt,
      playbookHitCount: c.reviewTasks[0] ? playbookCountMap.get(c.reviewTasks[0].id) ?? 0 : 0,
      hasReport: !!c.reportMd,
      review: c.reviewTasks[0]
        ? {
            id: c.reviewTasks[0].id,
            status: c.reviewTasks[0].status,
            isDeep: c.reviewTasks[0].isDeep,
            riskCount: c.reviewTasks[0]._count.risks,
            stats: c.reviewTasks[0].stats,
            createdAt: c.reviewTasks[0].createdAt,
          }
        : null,
    }))

    if (reviewStatus) {
      items = items.filter((c) => {
        if (reviewStatus === 'PENDING') {
          return c.status !== 'FAILED' && (!c.review || c.review.status === 'RUNNING')
        }
        if (reviewStatus === 'WAITING_REVIEW') return c.review?.status === 'WAITING_REVIEW'
        if (reviewStatus === 'APPROVED') return c.review?.status === 'APPROVED'
        if (reviewStatus === 'FAILED') return c.status === 'FAILED' || c.review?.status === 'REJECTED'
        return true
      })
    }

    return {
      // 空合同列表双等权动作：已领取过示例合同时前端隐藏「体验示例合同」
      sampleCopied: await this.onboarding.hasSampleContract(tenantId),
      contracts: items,
    }
  }

  // ── 合同详情：条款 + 最近一次审查任务及全部风险 ─────────────────
  @Get('contracts/:id')
  async detail(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const contract = await this.db.contract.findFirst({
      where: { id, tenantId },
      include: {
        clauses: { orderBy: { indexNo: 'asc' } },
        reviewTasks: { orderBy: { createdAt: 'desc' }, take: 1, include: { risks: { orderBy: { createdAt: 'asc' } } } },
      },
    })
    if (!contract) throw new NotFoundException('合同不存在')
    return {
      contract: {
        id: contract.id,
        title: contract.title,
        fileName: contract.fileName,
        status: contract.status,
        progress: contract.progress,
        parseError: contract.parseError,
        fileType: contract.fileType,
        scene: contract.scene,
        charCount: contract.charCount,
        clausesCount: contract.clausesCount,
        reportMd: contract.reportMd,
        structuredInfo: contract.structuredInfo ?? null,
        retainUntil: contract.retainUntil,
        createdAt: contract.createdAt,
      },
      clauses: contract.clauses.map((c) => ({
        id: c.id, indexNo: c.indexNo, title: c.title, clauseType: c.clauseType, content: c.content,
      })),
      review: contract.reviewTasks[0]
        ? {
            id: contract.reviewTasks[0].id,
            status: contract.reviewTasks[0].status,
            threadId: contract.reviewTasks[0].threadId,
            isDeep: contract.reviewTasks[0].isDeep,
            couponUsed: contract.reviewTasks[0].couponUsed,
            stats: contract.reviewTasks[0].stats,
            createdAt: contract.reviewTasks[0].createdAt,
            risks: contract.reviewTasks[0].risks.map(serializeRisk),
          }
        : null,
    }
  }

  // ── 企业审查台「结构化信息」：首次请求触发 AI 抽取并缓存；无 Key 409 ─
  @Get('contracts/:id/structured')
  async structuredInfo(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
    return this.structured.getOrExtract(tenantId, id, force)
  }

  @Delete('contracts/:id')
  async remove(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const result = await this.db.contract.deleteMany({ where: { id, tenantId } })
    if (!result.count) throw new NotFoundException('合同不存在')
    return { success: true }
  }

  // ── 发起审查（SSE：stage/risk/waiting/done）──────────────────
  // 归属与权益校验必须在 initSse 之前抛错，才能返回真正的 403/404（而非 SSE error 帧）
  @Post('contracts/:id/reviews')
  async startReviewStream(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: { payWithCoupon?: boolean },
  ) {
    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const payWithCoupon = !!body.payWithCoupon

    const contract = await this.db.contract.findFirst({ where: { id, tenantId } })
    if (!contract) throw new NotFoundException('合同不存在')
    if (!['READY', 'WAITING_REVIEW', 'COMPLETED'].includes(contract.status)) {
      throw new BadRequestException(`合同当前状态（${contract.status}）不可发起审查，请等待解析完成或处理解析失败`)
    }

    // 拦截点①：月额度 / 字数 / 非标类型（用券时仅校验券余额）
    const { deep } = await this.entitlements.assertStartReview(tenantId, {
      charCount: Math.max(contract.charCount, 1),
      scene: contract.scene,
      payWithCoupon,
    })

    // 拦截点②：AI 月度 token 配额预检（前移到扣券/建任务之前，失败不扣券；异常过滤器转 429）
    await this.quota.assert(tenantId)

    const sse = initSse(res)

    // 付费资产补偿标记：券已扣且审查未实际启动时，catch 中原子退还
    let couponCharged = false
    let reviewLaunched = false

    try {
      // 深度券通道：原子扣减 1 券（并发安全 updateMany），失败不建任务
      if (payWithCoupon) {
        const redeemed = await this.db.tenant.updateMany({
          where: { id: tenantId, couponBalance: { gt: 0 } },
          data: { couponBalance: { decrement: 1 } },
        })
        if (redeemed.count === 0) {
          throw new PlanLimitException('COUPON_REQUIRED', '深度券余额不足，请购买或订阅', 'coupon')
        }
        couponCharged = true
      }

      const reviewTask = await this.tracer.run(
        { feature: 'contract_review', name: `合同审查：${contract.title}`, tenantId, userId },
        async (handle) => {
          const task = await this.db.reviewTask.create({
            data: {
              tenantId,
              contractId: contract.id,
              threadId: `rev_${randomUUID()}`,
              status: 'RUNNING',
              isDeep: deep,
              couponUsed: payWithCoupon,
            },
          })
          sse.send('task', { taskId: task.id })

          await startReview({
            contract,
            reviewTask: task,
            deep,
            traceCallbacks: handle.callbacks,
            onEvent: (type, data) => sse.send(type, data),
          })
          reviewLaunched = true
          return task
        },
      )

      sse.send('done', { taskId: reviewTask.id, status: 'WAITING_REVIEW', deep })

      // 额度 80% 预警（FR-24）：异步检查，未达阈值 / 未配置均静默，不阻塞 SSE
      this.feishu.notifyQuota80(tenantId).catch((err) =>
        logger.warn('feishu: quota80 trigger failed', { error: (err as Error).message }))
    } catch (err) {
      // 券已扣但审查未实际启动：原子退还 1 张深度券，避免用户承担系统失败
      if (couponCharged && !reviewLaunched) {
        try {
          await this.db.tenant.updateMany({
            where: { id: tenantId },
            data: { couponBalance: { increment: 1 } },
          })
          logger.warn('review start failed after coupon charge; coupon refunded', {
            contractId: contract.id, error: (err as Error).message,
          })
        } catch (refundErr) {
          logger.error('coupon refund failed; manual intervention required', {
            contractId: contract.id, tenantId, error: (refundErr as Error).message,
          })
        }
      }
      logger.error('contract: review start failed', { error: (err as Error).message })
      sse.error(err)
    } finally {
      sse.end()
    }
  }

  // ── 合同助手：就本份合同追问（FREE 每合同 1 轮，深度套餐/券不限；FR-8）──
  @Post('contracts/:id/ask')
  async ask(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { question?: string },
  ) {
    const question = (body.question || '').trim()
    if (!question) throw new BadRequestException('请输入要追问的问题')
    if (question.length > 500) throw new BadRequestException('问题过长（上限 500 字）')
    return this.assistant.ask({
      tenantId: (req as any).user.tenantId,
      userId: (req as any).user.userId,
      contractId: id,
      question,
    })
  }

  // ── 待人工终审列表 ───────────────────────────────────────────
  @Get('reviews/pending')
  async pending(@Req() req: Request) {
    const tenantId = (req as any).user.tenantId
    const tasks = await this.db.reviewTask.findMany({
      where: { tenantId, status: 'WAITING_REVIEW' },
      orderBy: { updatedAt: 'desc' },
      include: { contract: { select: { id: true, title: true, fileName: true } } },
    })
    return { tasks: tasks.map((t) => ({ id: t.id, contract: t.contract, stats: t.stats, createdAt: t.createdAt })) }
  }

  // ── 单条审查任务详情 ─────────────────────────────────────────
  @Get('reviews/:taskId')
  async reviewDetail(@Req() req: Request, @Param('taskId') taskId: string) {
    const tenantId = (req as any).user.tenantId
    const task = await this.db.reviewTask.findFirst({
      where: { id: taskId, tenantId },
      include: { contract: true, risks: { orderBy: { createdAt: 'asc' } } },
    })
    if (!task) throw new NotFoundException('审查任务不存在')
    return {
      id: task.id,
      status: task.status,
      stats: task.stats,
      createdAt: task.createdAt,
      contract: { id: task.contract.id, title: task.contract.title, status: task.contract.status },
      risks: task.risks.map(serializeRisk),
      reportMd: task.contract.reportMd,
    }
  }

  // ── 人工终审：逐条处置 + 整体通过/驳回，恢复 LangGraph ─────────
  @Post('reviews/:taskId/decision')
  @Roles('ADMIN', 'MANAGER')
  async decision(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() body: {
      finalDecision?: 'APPROVED' | 'REJECTED'
      actions?: Array<{ riskId: string; status: 'ACCEPTED' | 'IGNORED' | 'EDITED'; comment?: string | null }>
    },
  ) {
    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    if (!body.finalDecision || !['APPROVED', 'REJECTED'].includes(body.finalDecision)) {
      throw new BadRequestException('finalDecision 必须是 APPROVED 或 REJECTED')
    }

    const task = await this.db.reviewTask.findFirst({ where: { id: taskId, tenantId } })
    if (!task) throw new NotFoundException('审查任务不存在')
    if (task.status !== 'WAITING_REVIEW') throw new BadRequestException('该任务不在待审状态')

    const actions = (body.actions || []).filter((a) => a.riskId && ['ACCEPTED', 'IGNORED', 'EDITED'].includes(a.status))

    await this.tracer.run(
      { feature: 'contract_review', name: `人工终审恢复：${taskId}`, tenantId, userId },
      async (handle) => {
        await resumeReview({
          reviewTask: task,
          actions,
          finalDecision: body.finalDecision as 'APPROVED' | 'REJECTED',
          reviewerId: userId,
          traceCallbacks: handle.callbacks,
        })
      },
    )

    const updated = await this.db.reviewTask.findUniqueOrThrow({
      where: { id: taskId },
      include: { contract: true, risks: true },
    })
    return {
      status: updated.status,
      contractStatus: updated.contract.status,
      reportMd: updated.contract.reportMd,
      stats: updated.stats,
    }
  }

  // ── 企业审批流：审批评论（仅审计留痕，不改变任务状态）──────────
  @Post('reviews/:taskId/comment')
  @Roles('ADMIN', 'MANAGER')
  async reviewComment(
    @Req() req: Request,
    @Param('taskId') taskId: string,
    @Body() body: { comment?: string },
  ) {
    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const comment = String(body?.comment || '').trim().slice(0, 500)
    if (!comment) throw new BadRequestException('评论内容不能为空')
    const task = await this.db.reviewTask.findFirst({ where: { id: taskId, tenantId } })
    if (!task) throw new NotFoundException('审查任务不存在')
    await this.audit.log({
      tenantId, userId, action: 'CONTRACT_REVIEW_COMMENT', resource: 'ReviewTask', resourceId: taskId,
      detail: { contractId: task.contractId, comment },
    })
    return { success: true }
  }

  // ── 意见书 Markdown ─────────────────────────────────────────
  @Get('reviews/:taskId/report')
  async report(@Req() req: Request, @Param('taskId') taskId: string) {
    const tenantId = (req as any).user.tenantId
    const task = await this.db.reviewTask.findFirst({
      where: { id: taskId, tenantId },
      include: { contract: true },
    })
    if (!task) throw new NotFoundException('审查任务不存在')
    if (!task.contract.reportMd) throw new ForbiddenException('审查尚未终审完成，意见书未生成')
    return { reportMd: task.contract.reportMd, title: task.contract.title }
  }

  // ── 意见书 Word 导出（FR-21：归属 / 终审状态 / 套餐权益三校验，PERSONAL+）──
  @Get('reviews/:taskId/report/docx')
  async reportDocx(
    @Req() req: Request,
    @Res() res: Response,
    @Param('taskId') taskId: string,
  ) {
    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const task = await this.db.reviewTask.findFirst({
      where: { id: taskId, tenantId },
      include: { contract: true, risks: true },
    })
    if (!task) throw new NotFoundException('审查任务不存在')
    if (!task.contract.reportMd) {
      throw new ForbiddenException('审查尚未终审完成，意见书未生成')
    }
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    this.entitlements.assertFeature(tenant.plan, 'wordExport', 'EXPORT')

    const buffer = await buildOpinionDocx(task.contract, task, task.risks)
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(`审查意见书_${task.contract.title}.docx`)}`,
    )
    res.end(buffer)

    await this.audit.log({
      tenantId,
      userId,
      action: 'CONTRACT_REPORT_EXPORT',
      resource: 'ReviewTask',
      resourceId: taskId,
      detail: { contractId: task.contractId, format: 'docx' },
    })
  }
}
