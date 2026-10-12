// server/src/integrations/integrations.controller.ts
// 集成中心接口（/api/integrations）。飞书写操作仅负责人；留资团队成员均可。
import { Body, Controller, Delete, Get, Post, Put, Req } from '@nestjs/common'
import { Roles } from '../auth/decorators/roles.decorator'
import { IntegrationsService } from './integrations.service.js'

@Controller('api/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('feishu')
  getFeishu(@Req() req: any) {
    return this.integrations.getFeishu(req.user.tenantId)
  }

  @Put('feishu')
  @Roles('ADMIN')
  saveFeishu(@Req() req: any, @Body() body: { webhookUrl?: string }) {
    return this.integrations.saveFeishu(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '')
  }

  @Delete('feishu')
  @Roles('ADMIN')
  removeFeishu(@Req() req: any) {
    return this.integrations.deleteFeishu(req.user.tenantId, req.user.userId)
  }

  @Post('feishu/test')
  @Roles('ADMIN')
  testFeishu(@Req() req: any) {
    return this.integrations.sendTest(req.user.tenantId, req.user.userId)
  }

  @Get('dingtalk')
  getDingtalk(@Req() req: any) {
    return this.integrations.getDingtalk(req.user.tenantId)
  }

  @Put('dingtalk')
  @Roles('ADMIN')
  saveDingtalk(@Req() req: any, @Body() body: { webhookUrl?: string; secret?: string }) {
    return this.integrations.saveDingtalk(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '', body?.secret)
  }

  @Delete('dingtalk')
  @Roles('ADMIN')
  removeDingtalk(@Req() req: any) {
    return this.integrations.deleteDingtalk(req.user.tenantId, req.user.userId)
  }

  @Post('dingtalk/test')
  @Roles('ADMIN')
  testDingtalk(@Req() req: any) {
    return this.integrations.sendDingtalkTest(req.user.tenantId, req.user.userId)
  }

  @Get('wework')
  getWework(@Req() req: any) {
    return this.integrations.getWework(req.user.tenantId)
  }

  @Put('wework')
  @Roles('ADMIN')
  saveWework(@Req() req: any, @Body() body: { webhookUrl?: string }) {
    return this.integrations.saveWework(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '')
  }

  @Delete('wework')
  @Roles('ADMIN')
  removeWework(@Req() req: any) {
    return this.integrations.deleteWework(req.user.tenantId, req.user.userId)
  }

  @Post('wework/test')
  @Roles('ADMIN')
  testWework(@Req() req: any) {
    return this.integrations.sendWeworkTest(req.user.tenantId, req.user.userId)
  }

  @Post('leads')
  createLead(
    @Req() req: any,
    @Body() body: { integration?: string; name?: string; phone?: string; note?: string },
  ) {
    return this.integrations.createLead(req.user.tenantId, req.user.userId, body || {})
  }
}
