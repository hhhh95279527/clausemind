// server/src/contract/contract.controller.ts
// 合同业务接口：上传/列表/详情 → 发起审查(SSE) → 待审列表 → 人工决策恢复 → 意见书
// 所有查询强制 tenantId 过滤；跨租户访问一律 404。
import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get,
  NotFoundException, OnModuleInit, Param, Patch, Post, Req, Res,
} from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
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
import { classifyScene, clausesToText } from './parsing/scene-classifier.js'
import { OnboardingService } from './onboarding/onboarding.service.js'
import { ContractAssistantService } from './assistant/contract-assistant.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { TrialService } from '../billing/trial.service.js'
import { PlanLimitException } from '../billing/plan-limit.exception.js'
import { getPlanDef, type ReviewScene } from '../billing/plans.config.js'
import { Prisma } from '@prisma/client'
import { setReviewDatabase, startReview, resumeReview, serializeRisk } from './review/review.agent.js'
import { buildOpinionDocx } from './review/report-docx.js'
import { PdfExportService } from './review/pdf-export.service.js'
import { removeContractVersions } from './review/archive.js'
import { StructuredService } from './review/structured.service.js'
import { AuditService } from '../audit/audit.service.js'
import { FeishuNotifyService } from '../services/feishu/feishu-notify.service.js'
import { DingtalkNotifyService } from '../services/dingtalk/dingtalk-notify.service.js'
import { WeworkNotifyService } from '../services/wework/wework-notify.service.js'
import { createReadStream } from 'node:fs'
import * as mammoth from 'mammoth'

const SCENES: ReviewScene[] = ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA', 'SALE', 'LOAN', 'EQUITY', 'CUSTOM']

@ApiTags('contract')
@ApiBearerAuth('bearer')
@Controller('api')
export class ContractController implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly parseService: ContractParseService,
    private readonly tracer: TraceService,
    private readonly quota: QuotaService,
    private readonly onboarding: OnboardingService,
    private readonly entitlements: EntitlementsService,
    private readonly trial: TrialService,
    private readonly assistant: ContractAssistantService,
    private readonly structured: StructuredService,
    private readonly audit: AuditService,
    private readonly feishu: FeishuNotifyService,
    private readonly dingtalk: DingtalkNotifyService,
    private readonly wework: WeworkNotifyService,
    private readonly pdf: PdfExportService,
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

  /**
   * 上传/改类型入参 → (scene, sceneSource)：
   * 'AUTO' / 缺省 = 待 AI 自动识别（scene 先占位 LABOR，由解析 worker / 审查轨回填）；
   * 其余合法值 = 用户手选（sceneSource=USER）。
   */
  private parseSceneInput(raw: unknown): { scene: ReviewScene; sceneSource: 'USER' | 'AUTO' } {
    if (raw === 'AUTO' || raw === undefined || raw === null || raw === '') {
      return { scene: 'LABOR', sceneSource: 'AUTO' }
    }
    return { scene: this.parseScene(raw), sceneSource: 'USER' }
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
        : new Date(Date.now() + getPlanDef('FREE').retentionDays! * 86_400_000),
    }
  }

  // ── 上传合同文件（multipart：file + title + scene）────────────
  @Post('contracts/upload')
  @ApiOperation({
    summary: '上传合同文件（multipart）',
    description: '支持 txt/md/docx/pdf/jpg/jpeg/png（图片走视觉 OCR）。按套餐限制单文件大小（FREE 8MB / 会员 15MB），上传后经魔数真实类型校验并异步入解析队列，返回建档的合同记录。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: '合同文件（txt/md/docx/pdf/jpg/jpeg/png）' },
        title: { type: 'string', maxLength: 200, description: '合同标题，缺省取文件名（去扩展名）' },
        scene: { type: 'string', enum: [...SCENES, 'AUTO'], description: '合同类型；传 AUTO=AI 自动识别（缺省即 AUTO）。付费场景 SALE/LOAN/EQUITY/CUSTOM 手选时受套餐拦截，AI 识别出的付费场景不拦截（回退为通用规则审查）', default: 'AUTO' },
      },
    },
  })
  async upload(@Req() req: Request, @Body() body: { title?: string; scene?: string }) {
    const file = (req as any).file as Express.Multer.File | undefined
    if (!file) throw new BadRequestException('请选择合同文件')

    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const ext = path.extname(file.originalname).toLowerCase()
    const { scene, sceneSource } = this.parseSceneInput(body.scene)

    // 按套餐校验文件大小（免费 8MB / 会员 15MB）；超限立即删除临时文件
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    const maxBytes = getPlanDef(tenant.plan).maxUploadBytes
    if (file.size > maxBytes) {
      await fs.unlink(file.path).catch(() => {})
      const maxMB = Math.round(maxBytes / (1024 * 1024))
      throw new BadRequestException(
        tenant.plan === 'FREE'
          ? `免费版单文件不能超过 ${maxMB}MB，升级会员版可上传 15MB`
          : `单文件不能超过 ${maxMB}MB`,
      )
    }

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
        storagePath: file.path,
        fileType: ext.slice(1) || 'txt',
        scene,
        sceneSource,
        status: 'UPLOADED' as const,
      }),
    })
    await this.parseService.enqueue(contract.id, file.path)
    logger.info('contract: uploaded', { contractId: contract.id, file: file.originalname, scene, sceneSource })
    return { contract }
  }

  // ── 直接粘贴合同文本 ─────────────────────────────────────────
  @Post('contracts/text')
  @ApiOperation({
    summary: '粘贴合同文本建档',
    description: '直接提交合同正文文本（上限 20 万字），服务端落临时文件后走与文件上传相同的解析队列。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['content'],
      properties: {
        title: { type: 'string', maxLength: 200, description: '合同标题，缺省为「合同文本 + 日期」' },
        content: { type: 'string', maxLength: 200000, description: '合同正文纯文本' },
        scene: { type: 'string', enum: [...SCENES, 'AUTO'], description: '合同类型；传 AUTO=AI 自动识别（缺省即 AUTO）', default: 'AUTO' },
      },
    },
  })
  async uploadText(
    @Req() req: Request,
    @Body() body: { title?: string; content?: string; scene?: string },
  ) {
    if (!body.content?.trim()) throw new BadRequestException('合同内容不能为空')
    if (body.content.length > 200_000) throw new BadRequestException('合同文本过长（上限 20 万字），请改用文件上传')

    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const { scene, sceneSource } = this.parseSceneInput(body.scene)
    await fs.mkdir('./uploads', { recursive: true })
    const tmpPath = `./uploads/contract_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.txt`
    await fs.writeFile(tmpPath, body.content, 'utf-8')

    const contract = await this.db.contract.create({
      data: await this.buildCreateData(tenantId, userId, {
        title: (body.title || `合同文本 ${new Date().toLocaleDateString('zh-CN')}`).slice(0, 200),
        fileName: '粘贴文本.txt',
        fileType: 'txt',
        scene,
        sceneSource,
        status: 'UPLOADED' as const,
      }),
    })
    await this.parseService.enqueue(contract.id, tmpPath)
    return { contract }
  }

  // ── 发起前预检：字数/场景/月额度/试用次数（不扣券、不建任务）；前端据此弹付费墙 ──
  @Post('contracts/eligibility')
  @ApiOperation({
    summary: '发起审查前预检（不扣券、不建任务）',
    description: '预检字数/场景权益/月度额度/FREE 试用次数。前端据此决定直接发起或弹付费墙。返回 allowed、deep（是否深度审查）及当前权益快照。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        charCount: { type: 'integer', minimum: 0, description: '合同字数（用于按字数判定套餐档位）' },
        scene: { type: 'string', enum: SCENES, description: '合同场景，缺省 LABOR', default: 'LABOR' },
        payWithCoupon: { type: 'boolean', description: '是否计划用深度券支付（用券时只校验券余额，不计试用次数）', default: false },
      },
    },
  })
  async eligibility(@Req() req: Request, @Body() body: { charCount?: number; scene?: string; payWithCoupon?: boolean }) {
    const tenantId = (req as any).user.tenantId
    const charCount = Number(body.charCount) || 0
    const scene = this.parseScene(body.scene)
    const payWithCoupon = !!body.payWithCoupon
    const { deep } = await this.entitlements.assertStartReview(tenantId, {
      charCount,
      scene,
      payWithCoupon,
    })
    // 试用拦截：FREE 非演示租户审查终身 2 次（用券属付费动作，不计）
    if (!payWithCoupon) {
      await this.trial.assertTrialAvailable(tenantId, 'REVIEW')
    }
    const snapshot = await this.entitlements.getEntitlementSnapshot(tenantId)
    return { allowed: true, deep, ...snapshot }
  }

  // ── 新手引导：体验示例合同（每租户限一次、不扣额度；FR-3）────────
  @Post('contracts/sample')
  @ApiOperation({ summary: '新手引导：领取体验示例合同', description: '每个租户限领一次；复制一份内置埋雷示例合同，不扣额度。' })
  async copySample(@Req() req: Request) {
    return this.onboarding.copySampleContract({
      userId: (req as any).user.userId,
      tenantId: (req as any).user.tenantId,
    })
  }

  // ── 合同列表（status 可选；含最近一次审查状态）─────────────────
  @Get('contracts')
  @ApiOperation({
    summary: '合同列表',
    description: '返回当前租户最近 100 份合同（含最近一次审查任务状态、风险数、Playbook 命中数）。reviewStatus 在内存中二次过滤：PENDING/WAITING_REVIEW/APPROVED/FAILED。返回 { sampleCopied, contracts }。',
  })
  @ApiQuery({ name: 'status', required: false, description: '按合同解析状态过滤，如 UPLOADED/READY/REVIEWING/WAITING_REVIEW/COMPLETED/FAILED' })
  @ApiQuery({ name: 'reviewStatus', required: false, enum: ['PENDING', 'WAITING_REVIEW', 'APPROVED', 'FAILED'], description: '按审查状态过滤' })
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
      sceneSource: c.sceneSource,
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
        if (reviewStatus === 'FAILED') return c.status === 'FAILED' || c.review?.status === 'REJECTED' || c.review?.status === 'FAILED'
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
  @ApiOperation({
    summary: '合同详情',
    description: '返回合同元信息、全部条款（按序号升序）及最近一次审查任务（含全部风险）。跨租户访问返回 404。',
  })
  @ApiParam({ name: 'id', description: '合同 ID' })
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
        sceneSource: contract.sceneSource,
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
  @ApiOperation({
    summary: '结构化信息抽取（企业审查台）',
    description: '首次请求触发 AI 抽取合同甲乙方、期限、金额等结构化信息并缓存；force=1 强制重抽。未配置 AI Key 返回 409。',
  })
  @ApiParam({ name: 'id', description: '合同 ID' })
  @ApiQuery({ name: 'force', required: false, enum: ['0', '1'], description: '传 1 强制重新抽取（默认 0 走缓存）' })
  async structuredInfo(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
    return this.structured.getOrExtract(tenantId, id, force)
  }

  // ── 合同原件在线预览（审查台左侧面板直接预览，不走下载）───────────
  // docx → mammoth 转 HTML；pdf/jpg/png → inline stream；txt/md → 纯文本包 <pre>。
  // 所有格式 Content-Disposition: inline，浏览器在 iframe/img 中直接呈现。
  @Get('contracts/:id/preview')
  @ApiOperation({
    summary: '合同原件在线预览',
    description: '返回可内嵌的预览内容：docx 转 HTML、pdf/图片 inline stream、txt/md 纯文本。跨租户 404。',
  })
  @ApiParam({ name: 'id', description: '合同 ID' })
  async preview(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const contract = await this.db.contract.findFirst({
      where: { id, tenantId },
      select: { id: true, fileName: true, storagePath: true, fileType: true },
    })
    if (!contract) throw new NotFoundException('合同不存在')
    if (!contract.storagePath) throw new NotFoundException('该合同无可预览的上传原件')

    const ext = path.extname(contract.fileName).toLowerCase() || `.${contract.fileType?.toLowerCase() ?? ''}`

    try {
      await fs.access(contract.storagePath)
    } catch {
      throw new NotFoundException('原件文件已丢失')
    }

    // docx → mammoth 转 HTML
    if (ext === '.docx') {
      const buffer = await fs.readFile(contract.storagePath)
      const result = await mammoth.convertToHtml({ buffer })
      const html = `<!doctype html><html><head><meta charset="utf-8">
<style>
  body{font-family:"Microsoft YaHei","PingFang SC",sans-serif;max-width:800px;margin:0 auto;padding:24px;line-height:1.8;color:#111;font-size:14px}
  h1,h2,h3{margin-top:24px}table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #ccc;padding:6px 10px}
  p{margin:6px 0}
</style>
</head><body>${result.value}</body></html>`
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Disposition', `inline; filename="preview.html"`)
      res.send(html)
      return
    }

    // pdf → inline stream（浏览器原生 PDF viewer）
    if (ext === '.pdf') {
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(contract.fileName)}"`)
      createReadStream(contract.storagePath).pipe(res)
      return
    }

    // 图片 → inline stream
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
      const mime: Record<string, string> = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp',
      }
      res.setHeader('Content-Type', mime[ext] || 'application/octet-stream')
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(contract.fileName)}"`)
      createReadStream(contract.storagePath).pipe(res)
      return
    }

    // txt / md / 其他文本 → 纯文本 HTML
    if (['.txt', '.md'].includes(ext) || ext === '') {
      const text = await fs.readFile(contract.storagePath, 'utf-8')
      const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
      const html = `<!doctype html><html><head><meta charset="utf-8">
<style>body{font-family:Consolas,"Courier New",monospace;padding:16px;white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.7}</style>
</head><body>${escaped}</body></html>`
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Content-Disposition', `inline; filename="preview.html"`)
      res.send(html)
      return
    }

    // 兜底：二进制 inline
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(contract.fileName)}"`)
    createReadStream(contract.storagePath).pipe(res)
  }

  // ── 修改合同类型（手选 / 重新 AI 识别）────────────────────────
  // 仅改 contracts.scene 与 scene_source；历史审查结果与归档全部保留，前端提示「建议重新审查」。
  @Patch('contracts/:id')
  @ApiOperation({
    summary: '修改合同类型',
    description: [
      '手动指定合同类型，或传 `scene=AUTO` 让 AI 重新自动识别（已解析完成时立即识别并回填，尚未解析完则交给解析 worker）。',
      '类型决定该合同适用哪些公司红线规则；修改不会自动失效旧审查结果，建议重新发起审查。跨租户访问返回 404。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '合同 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['scene'],
      properties: {
        scene: { type: 'string', enum: [...SCENES, 'AUTO'], description: '合同类型；传 AUTO 让 AI 自动识别' },
      },
    },
  })
  async updateScene(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { scene?: string },
  ) {
    const tenantId = (req as any).user.tenantId
    const contract = await this.db.contract.findFirst({ where: { id, tenantId } })
    if (!contract) throw new NotFoundException('合同不存在')

    const { scene, sceneSource } = this.parseSceneInput(body.scene)

    // 尚未解析完成：置 AUTO 由解析 worker 回填（人工识别需要全文与条款）
    if (sceneSource === 'AUTO' && !['READY', 'WAITING_REVIEW', 'COMPLETED'].includes(contract.status)) {
      const updated = await this.db.contract.update({
        where: { id },
        data: { scene: 'LABOR', sceneSource: 'AUTO' },
      })
      return { contract: { id: updated.id, scene: updated.scene, sceneSource: updated.sceneSource } }
    }

    // 已解析 + AUTO：用已入库条款文本立即识别
    if (sceneSource === 'AUTO') {
      const clauses = await this.db.clause.findMany({
        where: { contractId: id },
        orderBy: { indexNo: 'asc' },
        select: { title: true, content: true },
      })
      const result = await classifyScene(clausesToText(clauses), contract.title)
      if (result.source === 'DEFAULT') {
        // 结论不确定：保留用户原有类型，避免把已确认的类型改坏
        return {
          contract: { id: contract.id, scene: contract.scene, sceneSource: contract.sceneSource },
          detected: null,
        }
      }
      const updated = await this.db.contract.update({
        where: { id },
        data: { scene: result.scene, sceneSource: 'AI' },
      })
      logger.info('contract: scene re-detected', { contractId: id, scene: result.scene, source: result.source })
      return {
        contract: { id: updated.id, scene: updated.scene, sceneSource: updated.sceneSource },
        detected: { scene: result.scene, confidence: result.confidence, reason: result.reason ?? null, source: result.source },
      }
    }

    const updated = await this.db.contract.update({
      where: { id },
      data: { scene, sceneSource: 'USER' },
    })
    return { contract: { id: updated.id, scene: updated.scene, sceneSource: updated.sceneSource } }
  }

  @Delete('contracts/:id')
  @ApiOperation({ summary: '删除合同', description: '删除合同及其关联数据，并同步清理 uploads 中的上传原件。跨租户访问返回 404。' })
  @ApiParam({ name: 'id', description: '合同 ID' })
  async remove(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const existing = await this.db.contract.findFirst({
      where: { id, tenantId },
      select: { storagePath: true },
    })
    const result = await this.db.contract.deleteMany({ where: { id, tenantId } })
    if (!result.count) throw new NotFoundException('合同不存在')
    // 文件生命周期跟随合同：DB 记录删除后清理上传原件与归档版本目录
    if (existing?.storagePath) await fs.unlink(existing.storagePath).catch(() => {})
    await removeContractVersions(id)
    return { success: true }
  }

  // ── 发起审查（SSE：stage/risk/waiting/done）──────────────────
  // 归属与权益校验必须在 initSse 之前抛错，才能返回真正的 403/404（而非 SSE error 帧）
  @Post('contracts/:id/reviews')
  @ApiOperation({
    summary: '发起合同审查（SSE 流式）',
    description: [
      '成功返回 201 + `text/event-stream`，事件帧：`task`（任务建立）→ 多阶段 `stage`/`risk`（规则与 Agent 命中的风险增量推送）→ `waiting`（进入人工终审，LangGraph interrupt）/ `agent_skip`（无 AI Key 跳过 Agent 轨）→ `done`；失败发 `error` 帧后结束。',
      '归属/套餐/额度校验在 SSE 建立前完成，故越权与超额会以普通 403/404/429 HTTP 状态返回。深度券通道先原子扣券，审查未实际启动时自动退还。',
    ].join('\n'),
  })
  @ApiParam({ name: 'id', description: '合同 ID（须已解析完成：READY/WAITING_REVIEW/COMPLETED）' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        payWithCoupon: { type: 'boolean', description: '是否使用 1 张深度券发起深度审查（默认 false，按当前套餐判定）', default: false },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'SSE 事件流（text/event-stream）',
    content: { 'text/event-stream': { schema: { type: 'string', description: 'event: task|stage|risk|waiting|agent_skip|done|error\\ndata: { JSON }' } } },
  })
  async startReviewStream(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Body() body: { payWithCoupon?: boolean },
  ) {
    const tenantId = (req as any).user.tenantId
    const userId = (req as any).user.userId
    const payWithCoupon = !!body.payWithCoupon

    let contract = await this.db.contract.findFirst({ where: { id, tenantId } })
    if (!contract) throw new NotFoundException('合同不存在')

    // 僵死任务自愈：服务重启 / SSE 异常断开会把合同永久留在 REVIEWING、任务留在 RUNNING。
    // 最近一次任务 RUNNING 超过 10 分钟仍未汇总（stats 为空）即判定中断残留，复位后允许重新发起。
    if (contract.status === 'REVIEWING') {
      const latestTask = await this.db.reviewTask.findFirst({
        where: { contractId: contract.id },
        orderBy: { createdAt: 'desc' },
      })
      const STALE_MS = 10 * 60 * 1000
      const isStale = !!latestTask
        && latestTask.status === 'RUNNING'
        && !latestTask.stats
        && latestTask.createdAt.getTime() < Date.now() - STALE_MS
      if (isStale) {
        await this.db.reviewTask.update({ where: { id: latestTask!.id }, data: { status: 'FAILED' } })
        contract = await this.db.contract.update({ where: { id: contract.id }, data: { status: 'READY' } })
        logger.warn('review: stale RUNNING task reset to allow re-review', {
          contractId: contract.id, staleTaskId: latestTask!.id,
        })
      }
    }

    if (!['READY', 'WAITING_REVIEW', 'COMPLETED'].includes(contract.status)) {
      throw new BadRequestException(`合同当前状态（${contract.status}）不可发起审查，请等待解析完成或处理解析失败`)
    }

    // 拦截点①：月额度 / 字数 / 非标类型（用券时仅校验券余额）
    const { deep } = await this.entitlements.assertStartReview(tenantId, {
      charCount: Math.max(contract.charCount, 1),
      scene: contract.scene,
      payWithCoupon,
      // AI 自动识别出的付费场景不阻断：不提供该类专项红线，回退为通用规则审查（见 review.agent universalOnly）
      skipSceneLimit: contract.sceneSource === 'AI',
    })
    // 拦截点①b：FREE 非演示租户审查试用终身 2 次（用券不计）
    if (!payWithCoupon) {
      await this.trial.assertTrialAvailable(tenantId, 'REVIEW')
    }

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
          // 任务落库即计一次审查试用（用券属付费动作不计）
          if (!payWithCoupon) {
            await this.trial.consumeTrial(tenantId, 'REVIEW')
          }
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
      this.dingtalk.notifyQuota80(tenantId).catch((err) =>
        logger.warn('dingtalk: quota80 trigger failed', { error: (err as Error).message }))
      this.wework.notifyQuota80(tenantId).catch((err) =>
        logger.warn('wework: quota80 trigger failed', { error: (err as Error).message }))
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
  @ApiOperation({
    summary: '合同助手：就本份合同追问',
    description: '围绕指定合同上下文问答（FR-8）。FREE 租户每份合同限 1 轮，深度套餐/深度券不限；问题上限 500 字。',
  })
  @ApiParam({ name: 'id', description: '合同 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['question'],
      properties: { question: { type: 'string', maxLength: 500, description: '追问内容' } },
    },
  })
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

  // ── 人工终审：逐条处置 + 整体通过/驳回，恢复 LangGraph ─────────
  @Post('reviews/:taskId/decision')
  @Roles('ADMIN', 'MANAGER')
  @ApiOperation({
    summary: '人工终审决策（恢复 LangGraph）',
    description: 'ADMIN/MANAGER 对处于 WAITING_REVIEW 的任务做终审：可逐条处置风险（ACCEPTED/IGNORED/EDITED）并给出整体结论 APPROVED/REJECTED。终审通过后异步触发群机器人审查通过通知，并生成意见书。',
  })
  @ApiParam({ name: 'taskId', description: '审查任务 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['finalDecision'],
      properties: {
        finalDecision: { type: 'string', enum: ['APPROVED', 'REJECTED'], description: '整体终审结论' },
        actions: {
          type: 'array',
          description: '逐条风险处置（可空）',
          items: {
            type: 'object',
            required: ['riskId', 'status'],
            properties: {
              riskId: { type: 'string', description: '风险 ID' },
              status: { type: 'string', enum: ['ACCEPTED', 'IGNORED', 'EDITED'], description: '采纳/忽略/已编辑' },
              comment: { type: 'string', nullable: true, description: '处置备注' },
            },
          },
        },
      },
    },
  })
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

    // 终审通过：飞书 + 钉钉双通道群推送（异步，未配置/失败均静默，不影响审批响应）
    if (body.finalDecision === 'APPROVED') {
      const stats = (updated.stats as any) ?? {}
      const notifyParams = {
        tenantId,
        contractId: updated.contractId,
        contractTitle: updated.contract.title,
        stats: { total: stats.total, high: stats.high, med: stats.med, low: stats.low },
      }
      this.feishu.notifyReviewApproved(notifyParams).catch((err) =>
        logger.warn('feishu: review-approved trigger failed', { error: (err as Error).message }))
      this.dingtalk.notifyReviewApproved(notifyParams).catch((err) =>
        logger.warn('dingtalk: review-approved trigger failed', { error: (err as Error).message }))
      this.wework.notifyReviewApproved(notifyParams).catch((err) =>
        logger.warn('wework: review-approved trigger failed', { error: (err as Error).message }))
    }

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
  @ApiOperation({ summary: '审批评论（仅审计留痕）', description: '在企业审批流中追加评论，写入审计日志，不改变任务状态。评论上限 500 字。' })
  @ApiParam({ name: 'taskId', description: '审查任务 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['comment'],
      properties: { comment: { type: 'string', maxLength: 500, description: '评论内容' } },
    },
  })
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
  @ApiOperation({ summary: '获取审查意见书（Markdown）', description: '终审通过后才生成意见书；未终审完成返回 403。返回 { reportMd, title }。' })
  @ApiParam({ name: 'taskId', description: '审查任务 ID' })
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
  @ApiOperation({
    summary: '导出审查意见书（Word .docx）',
    description: '终审完成且具备导出权益（PERSONAL 及以上；FREE 非演示租户终身可试用 2 次）。文件名经 Content-Disposition 以 UTF-8 编码返回，并写审计日志。',
  })
  @ApiParam({ name: 'taskId', description: '审查任务 ID' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
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
    if (!this.entitlements.can(tenant.plan, 'wordExport')) {
      // 试用放宽：FREE 非演示租户报告导出终身 2 次，用尽抛 TRIAL_EXHAUSTED
      await this.trial.assertTrialAvailable(tenantId, 'EXPORT')
      await this.trial.consumeTrial(tenantId, 'EXPORT')
    }

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

  // ── 意见书 PDF 导出（与 docx 同校验：归属 / 终审状态 / 套餐权益）──
  @Get('reviews/:taskId/report/pdf')
  @ApiOperation({
    summary: '导出审查意见书（PDF）',
    description: '终审完成且具备导出权益。服务端 Edge 无头打印生成，内容口径与 Word 版一致。文件名经 Content-Disposition 以 UTF-8 编码返回，并写审计日志。',
  })
  @ApiParam({ name: 'taskId', description: '审查任务 ID' })
  @ApiProduces('application/pdf')
  async reportPdf(
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
    if (!this.entitlements.can(tenant.plan, 'wordExport')) {
      await this.trial.assertTrialAvailable(tenantId, 'EXPORT')
      await this.trial.consumeTrial(tenantId, 'EXPORT')
    }

    const html = this.pdf.buildOpinionHtml(task.contract, task, task.risks)
    const buffer = await this.pdf.htmlToPdf(html, { contractId: task.contractId })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="opinion.pdf"; filename*=UTF-8''${encodeURIComponent(`审查意见书_${task.contract.title}.pdf`)}`,
    )
    res.end(buffer)

    await this.audit.log({
      tenantId,
      userId,
      action: 'CONTRACT_REPORT_EXPORT',
      resource: 'ReviewTask',
      resourceId: taskId,
      detail: { contractId: task.contractId, format: 'pdf' },
    })
  }
}
