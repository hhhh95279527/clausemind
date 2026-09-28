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

  @Post('leads')
  createLead(
    @Req() req: any,
    @Body() body: { integration?: string; name?: string; phone?: string; note?: string },
  ) {
    return this.integrations.createLead(req.user.tenantId, req.user.userId, body || {})
  }
}
