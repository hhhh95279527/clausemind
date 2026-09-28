// server/src/contract/review/revision.controller.ts
// AI 改稿台接口（FR-9）：修订列表/生成/接受拒绝/重新生成/模拟反驳/Word 红划线导出
// 所有路径强制 tenantId 校验，跨租户访问 404；深度能力由 RevisionService 统一门禁。
import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import type { Request, Response } from 'express'
import { DatabaseService } from '../../database/database.service.js'
import { RevisionService, type RevisionStatusValue } from './revision.service.js'

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
  async list(@Req() req: Request, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    return this.revisions.list(tenantId, id, await this.planOf(tenantId))
  }

  // ── 一次性生成全部修订建议 ──
  @Post('contracts/:id/revisions/generate')
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
  async acceptAll(@Req() req: Request, @Param('id') id: string) {
    return this.revisions.acceptAll((req as any).user.tenantId, id)
  }

  // ── Word 红划线修订稿下载（真修订模式 w:ins/w:del）──
  @Get('contracts/:id/revisions/docx')
  async docx(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const tenantId = (req as any).user.tenantId
    await this.revisions.exportDocx(tenantId, id, await this.planOf(tenantId), res)
  }

  // ── 接受 / 拒绝 / 重置单条 ──
  @Post('risks/:riskId/revision')
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
  async regenerate(
    @Req() req: Request,
    @Param('riskId') riskId: string,
    @Body() body: { tone?: 'FIRM' | 'GENTLE' | 'NEUTRAL' },
  ) {
    return this.revisions.regenerate((req as any).user.tenantId, riskId, body.tone || 'NEUTRAL')
  }

  // ── 模拟对方反驳 ──
  @Post('risks/:riskId/revision/rebuttal')
  async rebuttal(@Req() req: Request, @Param('riskId') riskId: string) {
    return this.revisions.rebuttal((req as any).user.tenantId, riskId)
  }
}
