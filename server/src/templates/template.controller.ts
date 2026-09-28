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
import type { Response } from 'express'
import { TemplateService } from './template.service.js'

@Controller('api/templates')
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  @Get()
  list(
    @Req() req: any,
    @Query('category') category?: string,
    @Query('q') q?: string,
  ) {
    return this.templates.list(req.user.tenantId, { category, q })
  }

  @Get(':docId/preview')
  preview(@Req() req: any, @Param('docId') docId: string) {
    return this.templates.preview(req.user.tenantId, docId)
  }

  @Post(':docId/adopt')
  adopt(
    @Req() req: any,
    @Param('docId') docId: string,
    @Body() body: { title?: string } | undefined,
  ) {
    return this.templates.adopt(req.user.tenantId, req.user.userId, docId, body?.title)
  }

  @Get(':docId/download')
  async download(
    @Req() req: any,
    @Res() res: Response,
    @Param('docId') docId: string,
  ) {
    await this.templates.downloadDocx(req.user.tenantId, req.user.userId, docId, res)
  }
}
