// server/src/playbook/playbook.controller.ts
// Playbook 企业审查规则接口（FR-17，/api/playbook）：
//   GET    /rules?kind=FORBIDDEN|PREFERENCE   规则列表（含近 30 天命中数）
//   POST   /rules                             新建规则
//   PATCH  /rules/:id                         编辑规则
//   PATCH  /rules/:id/toggle                  启停
//   DELETE /rules/:id                         删除
//   POST   /rules/parse                       自然语言 → 结构化草稿（无 Key 409）
//   POST   /rules/test                        样例条款本地试命中
//   GET    /packs                             行业专项包列表
//   POST   /packs/:code/enable                一键复制为租户规则
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common'
import { PlaybookService, type RuleUpsertDto } from './playbook.service.js'

@Controller('api/playbook')
export class PlaybookController {
  constructor(private readonly playbook: PlaybookService) {}

  @Get('rules')
  list(@Req() req: any, @Query('kind') kind?: string) {
    return this.playbook.listRules(req.user.tenantId, kind)
  }

  @Post('rules')
  create(@Req() req: any, @Body() body: RuleUpsertDto) {
    return this.playbook.createRule(req.user.tenantId, req.user.userId, body || {})
  }

  @Post('rules/parse')
  parse(@Body() body: { naturalPrompt?: string; contractTypes?: string[] }) {
    return this.playbook.parseRule(body?.naturalPrompt ?? '', body?.contractTypes ?? [])
  }

  @Post('rules/test')
  test(@Body() body: { pattern?: unknown; samples?: unknown }) {
    return this.playbook.testRule(body?.pattern, body?.samples)
  }

  @Patch('rules/:id')
  update(@Req() req: any, @Param('id') id: string, @Body() body: RuleUpsertDto) {
    return this.playbook.updateRule(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Patch('rules/:id/toggle')
  toggle(@Req() req: any, @Param('id') id: string, @Body() body: { enabled?: boolean }) {
    return this.playbook.toggleRule(req.user.tenantId, req.user.userId, id, body?.enabled === true)
  }

  @Delete('rules/:id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.playbook.deleteRule(req.user.tenantId, req.user.userId, id)
  }

  @Get('packs')
  packs(@Req() req: any) {
    return this.playbook.listPacks(req.user.tenantId)
  }

  @Post('packs/:code/enable')
  enablePack(@Req() req: any, @Param('code') code: string) {
    return this.playbook.enablePack(req.user.tenantId, req.user.userId, code)
  }
}
