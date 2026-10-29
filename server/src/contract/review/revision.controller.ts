// server/src/contract/review/revision.controller.ts
// AI 改稿台接口（FR-9）：修订列表/生成/接受拒绝/重新生成/模拟反驳/Word 红划线导出
// 文档归档时间线（FR：修改前后文档归档）：版本列表/归档文件下载/修订稿 PDF 导出
// 所有路径强制 tenantId 校验，跨租户访问 404；深度能力由 RevisionService 统一门禁。
import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiProduces, ApiQuery, ApiTags } from '@nestjs/swagger'
import type { Request, Response } from 'express'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { DatabaseService } from '../../database/database.service.js'
import { RevisionService, type RevisionStatusValue } from './revision.service.js'
import { versionContentType, versionDisposition } from './archive.js'

@ApiTags('contract')
@ApiBearerAuth('bearer')
@Controller('api')
export class RevisionController {
  constructor(
    private readonly db: DatabaseService,
    private readonly revisions: RevisionService,
  ) {}

  private async planOf(tenantId: string) {
    const tenant = await this.db.tenant.findUniqueOrThrow({ where: { id: tenantId } })
    return tenant.plan
  }

  // ── 改稿台数据 ──
  @Get('contracts/:id/revisions')
  @ApiOperation({ summary: '改稿台：获取合同的修订建议列表', description: '返回该合同全部风险点及对应的 AI 改写建议、接受状态。跨租户访问返回 404。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async list(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    return this.revisions.list(tenantId, id, await this.planOf(tenantId))
  }

  // ── 一次性生成全部修订建议 ──
  @Post('contracts/:id/revisions/generate')
  @ApiOperation({ summary: '改稿台：批量生成修订建议', description: '深度权益功能（个人版及以上或使用深度券）。force=true 时忽略缓存重新生成。' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: '是否强制重新生成（默认 false，走缓存）', default: false } },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async generate(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { force?: boolean },
  ) {
    const tenantId = (req as any).user.tenantId
    return this.revisions.generate(tenantId, id, await this.planOf(tenantId), !!body.force)
  }

  // ── 全部接受 ──
  @Post('contracts/:id/revisions/accept-all')
  @ApiOperation({ summary: '改稿台：一键接受全部修订建议' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async acceptAll(@Req() req: Request, @Param('id') id: string) {
    return this.revisions.acceptAll((req as any).user.tenantId, id)
  }

  // ── Word 修订后合同下载（默认 clean 干净终稿；mode=redline 为红划线修订稿）──
  @Get('contracts/:id/revisions/docx')
  @ApiOperation({
    summary: '改稿台：导出 Word 修订后合同（.docx）',
    description: 'clean（默认）：把已采纳的改写直接应用进原件，输出无修订痕迹、可直接定稿的「修订后新合同」，保留全部原始版式；redline：注入 w:ins/w:del 修订痕迹供对照复核。docx 原件在原 OOXML 上应用，其他来源走文本重建。响应头 X-Revision-Applied/-Unmatched 标示原句命中/未命中条数。',
  })
  @ApiQuery({ name: 'mode', required: false, enum: ['clean', 'redline'], description: '默认 clean（修订后新合同）' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  async docx(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Query('mode') mode?: string,
  ) {
    const tenantId = (req as any).user.tenantId
    const m = mode === 'redline' ? 'redline' : 'clean'
    await this.revisions.exportDocx(tenantId, id, await this.planOf(tenantId), res, m)
  }

  // ── 接受 / 拒绝 / 重置单条 ──
  @Post('risks/:riskId/revision')
  @ApiOperation({ summary: '改稿台：接受/拒绝/重置单条修订' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['NONE', 'PENDING', 'ACCEPTED', 'REJECTED'], description: 'NONE=重置，ACCEPTED=接受，REJECTED=拒绝' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async setStatus(
    @Req() req: Request,
    @Param('riskId') riskId: string,
    @Body() body: { status?: RevisionStatusValue },
  ) {
    if (!body.status) return { ok: false }
    return this.revisions.setStatus((req as any).user.tenantId, riskId, body.status)
  }

  // ── 重新生成单条 ──
  @Post('risks/:riskId/revision/regenerate')
  @ApiOperation({ summary: '改稿台：按语气重新生成单条修订建议' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        tone: { type: 'string', enum: ['FIRM', 'GENTLE', 'NEUTRAL'], description: 'FIRM=强硬 / GENTLE=温和 / NEUTRAL=中性（默认）', default: 'NEUTRAL' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async regenerate(
    @Req() req: Request,
    @Param('riskId') riskId: string,
    @Body() body: { tone?: 'FIRM' | 'GENTLE' | 'NEUTRAL' },
  ) {
    return this.revisions.regenerate((req as any).user.tenantId, riskId, body.tone || 'NEUTRAL')
  }

  // ── 模拟对方反驳 ──
  @Post('risks/:riskId/revision/rebuttal')
  @ApiOperation({ summary: '改稿台：模拟对方就该风险点进行反驳', description: 'AI 生成谈判对手视角的反驳理由，辅助用户准备沟通策略。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async rebuttal(@Req() req: Request, @Param('riskId') riskId: string) {
    return this.revisions.rebuttal((req as any).user.tenantId, riskId)
  }

  // ── 用户手写改写句（覆盖 AI 生成的 rewritten，采纳后导出用用户版本）──
  @Post('risks/:riskId/rewrite')
  @ApiOperation({ summary: '审查台：保存用户手写的改写句并标记采纳', description: '用户在风险卡片里手写自己的修改示例，保存后覆写 risk.rewritten 并置 revisionStatus=ACCEPTED。Word/PDF 导出将使用该版本。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['rewritten'],
      properties: {
        rewritten: { type: 'string', description: '用户手写的改写后条款文本（最终进入修订稿的版本）' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  async saveRewrite(
    @Req() req: Request,
    @Param('riskId') riskId: string,
    @Body() body: { rewritten?: string },
  ) {
    if (!body.rewritten?.trim()) return { ok: false, error: '改写内容不能为空' }
    return this.revisions.saveRewrite((req as any).user.tenantId, riskId, body.rewritten.trim())
  }

  // ── 改稿台：导出修订稿 PDF（redline 红划线 / clean 干净终版）──
  @Get('contracts/:id/revisions/pdf')
  @ApiOperation({
    summary: '改稿台：导出修订稿 PDF（红划线版 / 干净终版）',
    description: 'variant=redline 保留红/蓝修订痕迹（删除线=原文、下划线=改写）；variant=clean 仅呈现修订后正文。服务端 Edge 无头打印生成，深度权益门禁与 docx 导出一致。',
  })
  @ApiQuery({ name: 'variant', required: false, enum: ['redline', 'clean'], description: '默认 redline（红划线版）' })
  @ApiProduces('application/pdf')
  async revisionPdf(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Query('variant') variant?: string,
  ) {
    const tenantId = (req as any).user.tenantId
    const v = variant === 'clean' ? 'clean' : 'redline'
    await this.revisions.exportPdf(tenantId, id, await this.planOf(tenantId), v, res)
  }

  // ── 文档归档：版本时间线（原始合同动态合成 + 意见书 + 修订稿链）──
  @Get('contracts/:id/versions')
  @ApiOperation({
    summary: '文档归档：获取合同的文档版本时间线',
    description: '按时间倒序返回：ORIGINAL 原始合同（无归档行时用合同原件动态合成）、OPINION 审查意见书、REVISED 修订稿（每次导出归档一版）。跨租户访问返回 404。',
  })
  @ApiOkResponse({ schema: { type: 'object', properties: { contractId: { type: 'string' }, title: { type: 'string' }, versions: { type: 'array', items: { type: 'object', additionalProperties: true } } } } })
  async versions(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    const contract = await this.db.contract.findFirst({
      where: { id, tenantId },
      select: { id: true, title: true, fileName: true, createdAt: true, storagePath: true },
    })
    if (!contract) throw new NotFoundException('合同不存在')

    const rows = await this.db.contractVersion.findMany({
      where: { contractId: id, tenantId },
      orderBy: { createdAt: 'desc' },
    })
    const versions: Array<{
      id: string; kind: string; fileName: string; sizeBytes: number
      appliedCount: number | null; unmatchedCount: number | null; createdAt: Date
    }> = rows.map((v) => ({
      id: v.id,
      kind: v.kind,
      fileName: v.fileName,
      sizeBytes: v.sizeBytes,
      appliedCount: v.appliedCount,
      unmatchedCount: v.unmatchedCount,
      createdAt: v.createdAt,
    }))

    // 原件兜底：不复制文件，下载时直接引用 contracts.storage_path
    if (!versions.some((v) => v.kind === 'ORIGINAL') && contract.storagePath) {
      versions.push({
        id: `original:${contract.id}`,
        kind: 'ORIGINAL',
        fileName: contract.fileName,
        sizeBytes: 0,
        appliedCount: null,
        unmatchedCount: null,
        createdAt: contract.createdAt,
      })
    }
    // 保持整体按时间倒序（合成的原件行也要归位）
    versions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return { contractId: contract.id, title: contract.title, versions }
  }

  // ── 文档归档：下载某个归档版本（原件 / 意见书 / 修订稿）──
  @Get('contracts/:id/versions/:versionId/download')
  @ApiOperation({
    summary: '文档归档：下载某个归档版本',
    description: 'ORIGINAL 直接流式返回上传原件；OPINION/REVISED 返回归档文件。下载已归档文件不消耗试用次数、不重复归档。跨租户访问返回 404。',
  })
  async downloadVersion(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    const tenantId = (req as any).user.tenantId
    const contract = await this.db.contract.findFirst({
      where: { id, tenantId },
      select: { id: true, fileName: true, storagePath: true },
    })
    if (!contract) throw new NotFoundException('合同不存在')

    let filePath: string | null = null
    let fileName = contract.fileName
    if (versionId === `original:${contract.id}`) {
      filePath = contract.storagePath
    } else {
      const v = await this.db.contractVersion.findFirst({ where: { id: versionId, contractId: id, tenantId } })
      if (!v) throw new NotFoundException('版本不存在')
      filePath = v.storagePath
      fileName = v.fileName
    }
    if (!filePath) throw new NotFoundException('该版本无可下载文件')

    let size = 0
    try {
      size = (await stat(filePath)).size
    } catch {
      throw new NotFoundException('归档文件已丢失，请重新导出')
    }
    res.setHeader('Content-Type', versionContentType(fileName))
    res.setHeader('Content-Disposition', versionDisposition(fileName))
    res.setHeader('Content-Length', String(size))
    createReadStream(filePath).pipe(res)
  }
}
