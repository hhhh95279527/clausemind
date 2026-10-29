// server/src/tenant-templates/tenant-template.controller.ts
// 租户自有合同范本接口（/api/tenant-templates，个人/团队空间通用）：
//   POST   /upload              上传范本（multipart，multer 中间件在 app.module 按路由挂载）
//   GET    /                    范本列表（不含全文）
//   GET    /:id                 范本详情（含全文，预览用）
//   PATCH  /:id                 在线编辑范本（标题/正文；原始文件不动）
//   DELETE /:id                 删除范本（同步清理磁盘文件）
//   POST   /:id/extract-rules   AI 提炼候选审查规则（不落库；无 Key 503、超限 429）
import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { TenantTemplateService } from './tenant-template.service.js'

@ApiTags('tenant-templates')
@ApiBearerAuth('bearer')
@Controller('api/tenant-templates')
export class TenantTemplateController {
  constructor(private readonly templates: TenantTemplateService) {}

  @Post('upload')
  @ApiOperation({
    summary: '上传自有合同范本（multipart）',
    description: '个人/团队空间均可。支持文字版 txt/md/docx/pdf（≤30MB），同步提取全文入库；不支持扫描件/图片。每租户上限 30 份。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: '范本文件（txt/md/docx/pdf）' },
        title: { type: 'string', maxLength: 200, description: '范本标题，缺省取文件名（去扩展名）' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  upload(@Req() req: any, @Body() body: { title?: string }) {
    return this.templates.upload(req.user.tenantId, req.user.userId, req.file, body?.title)
  }

  @Get()
  @ApiOperation({ summary: '自有范本列表', description: '返回当前租户的自有范本（不含正文大字段）与数量上限。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  list(@Req() req: any) {
    return this.templates.list(req.user.tenantId)
  }

  @Get(':id')
  @ApiOperation({ summary: '自有范本详情（含全文）', description: '在线预览用；跨租户访问返回 404。' })
  @ApiParam({ name: 'id', description: '范本 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  detail(@Req() req: any, @Param('id') id: string) {
    return this.templates.detail(req.user.tenantId, id)
  }

  @Patch(':id')
  @ApiOperation({
    summary: '在线编辑自有范本（标题/正文）',
    description: '仅修改库内在线文本（在线预览与 AI 提炼规则以修改后的正文为准），不改动磁盘原始上传文件；如需替换文件请删除后重新上传。跨租户访问返回 404。',
  })
  @ApiParam({ name: 'id', description: '范本 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200, description: '范本标题（可选）' },
        content: { type: 'string', maxLength: 200000, description: '范本正文（可选，传则整体替换，字数统计同步更新）' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  update(@Req() req: any, @Param('id') id: string, @Body() body: { title?: string; content?: string }) {
    return this.templates.update(req.user.tenantId, req.user.userId, id, body)
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除自有范本', description: '删除范本记录与磁盘文件；已从该范本导入的审查规则独立保留，不受影响。' })
  @ApiParam({ name: 'id', description: '范本 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.templates.remove(req.user.tenantId, req.user.userId, id)
  }

  @Post(':id/extract-rules')
  @ApiOperation({
    summary: 'AI 从范本提炼候选审查规则',
    description: '不落库，返回候选规则数组（≤8 条，每条含范本原句依据 evidence），由用户人工勾选/编辑后再调 /playbook/rules/import 导入。未配置 Key 返回 503，月度 token 超限返回 429。',
  })
  @ApiParam({ name: 'id', description: '范本 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        focus: { type: 'string', maxLength: 500, description: '可选，提炼重点（如"付款与违约条款"）；留空则全文提炼' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  extract(@Req() req: any, @Param('id') id: string, @Body() body: { focus?: string }) {
    return this.templates.extractRules(req.user.tenantId, id, body?.focus)
  }
}
