// server/src/templates/template.controller.ts
// 合同范本库接口（FR-20）。预览对全部登录用户开放；采用/下载由服务端按套餐拦截。
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger'
import type { Response } from 'express'
import { TemplateService } from './template.service.js'

@ApiTags('templates')
@ApiBearerAuth('bearer')
@Controller('api/templates')
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  @Get()
  @ApiOperation({ summary: '范本列表', description: '按分类/关键词返回平台合同范本列表；具体可采用范围由当前套餐决定。' })
  @ApiQuery({ name: 'category', required: false, description: '范本分类' })
  @ApiQuery({ name: 'q', required: false, description: '关键词搜索' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  list(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('q') q?: string,
  ) {
    return this.templates.list(req.user.tenantId, { category, q })
  }

  @Get(':docId/preview')
  @ApiOperation({ summary: '范本预览', description: '返回范本正文内容供在线预览，所有登录用户可访问。' })
  @ApiParam({ name: 'docId', description: '范本 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  preview(@Req() req: any, @Param('docId') docId: string) {
    return this.templates.preview(req.user.tenantId, docId)
  }

  @Post(':docId/adopt')
  @ApiOperation({ summary: '采用范本（复制为我的合同）', description: '把范本复制为当前租户的一份合同；受套餐权益拦截。' })
  @ApiParam({ name: 'docId', description: '范本 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { title: { type: 'string', description: '采用后的合同标题，缺省用范本标题' } },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  adopt(
    @Req() req: any,
    @Param('docId') docId: string,
    @Body() body: { title?: string } | undefined,
  ) {
    return this.templates.adopt(req.user.tenantId, req.user.userId, docId, body?.title)
  }

  @Get(':docId/download')
  @ApiOperation({ summary: '下载范本（Word .docx）', description: '按套餐放行下载，返回二进制流；文件名经 Content-Disposition 以 UTF-8 编码返回。' })
  @ApiParam({ name: 'docId', description: '范本 ID' })
  @ApiProduces('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  async download(
    @Req() req: any,
    @Res() res: Response,
    @Param('docId') docId: string,
  ) {
    await this.templates.downloadDocx(req.user.tenantId, req.user.userId, docId, res)
  }
}
