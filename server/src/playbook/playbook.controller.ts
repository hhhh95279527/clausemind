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
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags, type SchemaObject } from '@nestjs/swagger'
import { PlaybookService, type RuleUpsertDto } from './playbook.service.js'

const SCENE_TYPES = ['LABOR', 'INTERNSHIP', 'LEASE', 'SERVICE', 'NDA', 'SALE', 'LOAN', 'EQUITY', 'CUSTOM', 'ALL']

const ruleBodySchema: SchemaObject = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '规则标题' },
    description: { type: 'string', nullable: true, description: '规则说明' },
    naturalPrompt: { type: 'string', description: '自然语言规则描述（可由 /rules/parse 解析为 pattern）' },
    kind: { type: 'string', enum: ['FORBIDDEN', 'PREFERENCE'], description: 'FORBIDDEN=公司禁写红线，PREFERENCE=起草偏好' },
    contractTypes: { type: 'array', items: { type: 'string', enum: SCENE_TYPES }, description: '生效的合同场景，ALL 表示全部' },
    enabled: { type: 'boolean', description: '是否启用' },
    pattern: {
      type: 'object',
      description: '结构化匹配模式（与 naturalPrompt 二选一或并存）',
      properties: {
        keywords: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 }, description: '关键词列表（最多 20 个）' },
        regex: { type: 'string', nullable: true, description: '正则表达式（保存时校验可编译）' },
        severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'], description: '命中风险等级' },
        suggestion: { type: 'string', description: '修改建议' },
      },
    },
  },
}

@ApiTags('playbook')
@ApiBearerAuth('bearer')
@Controller('api/playbook')
export class PlaybookController {
  constructor(private readonly playbook: PlaybookService) {}

  @Get('rules')
  @ApiOperation({ summary: '规则列表', description: '返回当前租户的 Playbook 规则及近 30 天命中数。' })
  @ApiQuery({ name: 'kind', required: false, enum: ['FORBIDDEN', 'PREFERENCE'], description: '按规则类型过滤' })
  list(@Req() req: any, @Query('kind') kind?: string) {
    return this.playbook.listRules(req.user.tenantId, kind)
  }

  @Post('rules')
  @ApiOperation({ summary: '新建规则' })
  @ApiBody({ schema: ruleBodySchema })
  create(@Req() req: any, @Body() body: RuleUpsertDto) {
    return this.playbook.createRule(req.user.tenantId, req.user.userId, body || {})
  }

  @Post('rules/parse')
  @ApiOperation({ summary: '自然语言解析为规则草稿', description: '把自然语言规则描述解析为结构化 pattern 草稿供前端编辑；未配置 AI Key 返回 409。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['naturalPrompt'],
      properties: {
        naturalPrompt: { type: 'string', description: '自然语言规则描述' },
        contractTypes: { type: 'array', items: { type: 'string', enum: SCENE_TYPES }, description: '适用场景' },
      },
    },
  })
  parse(@Body() body: { naturalPrompt?: string; contractTypes?: string[] }) {
    return this.playbook.parseRule(body?.naturalPrompt ?? '', body?.contractTypes ?? [])
  }

  @Post('rules/test')
  @ApiOperation({ summary: '样例条款试命中', description: '在不落库的前提下，用给定 pattern 对样例条款本地试跑，返回命中结果。' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        pattern: { description: '结构化匹配模式（keywords/regex/severity/suggestion）' },
        samples: { type: 'array', items: { type: 'string' }, description: '待试命中的样例条款文本列表' },
      },
    },
  })
  test(@Body() body: { pattern?: unknown; samples?: unknown }) {
    return this.playbook.testRule(body?.pattern, body?.samples)
  }

  @Post('rules/import')
  @ApiOperation({
    summary: '从自有范本批量导入候选规则',
    description: '把 /tenant-templates/:id/extract-rules 返回、经用户人工勾选/编辑后的候选规则批量入库（source=AI，单次 ≤8 条），导入后立即启用。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['templateId', 'rules'],
      properties: {
        templateId: { type: 'string', description: '来源自有范本 ID' },
        rules: {
          type: 'array',
          maxItems: 8,
          items: {
            type: 'object',
            required: ['title', 'content', 'kind'],
            properties: {
              title: { type: 'string', maxLength: 80 },
              content: { type: 'string', description: '完整规则内容句，落 naturalPrompt', maxLength: 300 },
              kind: { type: 'string', enum: ['FORBIDDEN', 'PREFERENCE'] },
              contractTypes: { type: 'array', items: { type: 'string' } },
              keywords: { type: 'array', items: { type: 'string' } },
              regex: { type: 'string', nullable: true },
              severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
              suggestion: { type: 'string', maxLength: 300 },
            },
          },
        },
      },
    },
  })
  importRules(
    @Req() req: any,
    @Body() body: { templateId?: string; rules?: Parameters<PlaybookService['importFromTemplate']>[3] },
  ) {
    return this.playbook.importFromTemplate(
      req.user.tenantId,
      req.user.userId,
      body?.templateId ?? '',
      Array.isArray(body?.rules) ? body!.rules : [],
    )
  }

  @Patch('rules/:id')
  @ApiOperation({ summary: '编辑规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiBody({ schema: ruleBodySchema })
  update(@Req() req: any, @Param('id') id: string, @Body() body: RuleUpsertDto) {
    return this.playbook.updateRule(req.user.tenantId, req.user.userId, id, body || {})
  }

  @Patch('rules/:id/toggle')
  @ApiOperation({ summary: '启用/停用规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { enabled: { type: 'boolean', description: 'true=启用，false=停用' } },
    },
  })
  toggle(@Req() req: any, @Param('id') id: string, @Body() body: { enabled?: boolean }) {
    return this.playbook.toggleRule(req.user.tenantId, req.user.userId, id, body?.enabled === true)
  }

  @Delete('rules/:id')
  @ApiOperation({ summary: '删除规则' })
  @ApiParam({ name: 'id', description: '规则 ID' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.playbook.deleteRule(req.user.tenantId, req.user.userId, id)
  }

  @Get('packs')
  @ApiOperation({ summary: '行业专项包列表', description: '平台预置行业规则包，含是否已启用状态。' })
  packs(@Req() req: any) {
    return this.playbook.listPacks(req.user.tenantId)
  }

  @Post('packs/:code/enable')
  @ApiOperation({ summary: '一键启用行业专项包', description: '将专项包规则复制为当前租户的 Playbook 规则。' })
  @ApiParam({ name: 'code', description: '专项包编码' })
  enablePack(@Req() req: any, @Param('code') code: string) {
    return this.playbook.enablePack(req.user.tenantId, req.user.userId, code)
  }
}
