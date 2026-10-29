// server/src/integrations/integrations.controller.ts
// 集成中心接口（/api/integrations）。飞书写操作仅负责人；留资团队成员均可。
import { Body, Controller, Delete, Get, Post, Put, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Roles } from '../auth/decorators/roles.decorator'
import { IntegrationsService } from './integrations.service.js'

@ApiTags('integrations')
@ApiBearerAuth('bearer')
@Controller('api/integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('feishu')
  @ApiOperation({ summary: '获取飞书群机器人配置', description: '凭证 AES-GCM 加密存储，仅返回 webhook 脱敏信息（如末位标识）。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getFeishu(@Req() req: any) {
    return this.integrations.getFeishu(req.user.tenantId)
  }

  @Put('feishu')
  @Roles('ADMIN')
  @ApiOperation({ summary: '保存飞书群机器人配置（仅 ADMIN）', description: '仅允许提交到飞书官方域名的 webhook，凭证加密落库。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['webhookUrl'],
      properties: { webhookUrl: { type: 'string', format: 'uri', description: '飞书群机器人 webhook 地址（open.feishu.cn 官方域名）' } },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  saveFeishu(@Req() req: any, @Body() body: { webhookUrl?: string }) {
    return this.integrations.saveFeishu(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '')
  }

  @Delete('feishu')
  @Roles('ADMIN')
  @ApiOperation({ summary: '删除飞书群机器人配置（仅 ADMIN）' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  removeFeishu(@Req() req: any) {
    return this.integrations.deleteFeishu(req.user.tenantId, req.user.userId)
  }

  @Post('feishu/test')
  @Roles('ADMIN')
  @ApiOperation({ summary: '发送飞书测试消息（仅 ADMIN）' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  testFeishu(@Req() req: any) {
    return this.integrations.sendTest(req.user.tenantId, req.user.userId)
  }

  @Get('dingtalk')
  @ApiOperation({ summary: '获取钉钉群机器人配置', description: '凭证加密存储，页面仅展示脱敏信息。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getDingtalk(@Req() req: any) {
    return this.integrations.getDingtalk(req.user.tenantId)
  }

  @Put('dingtalk')
  @Roles('ADMIN')
  @ApiOperation({ summary: '保存钉钉群机器人配置（仅 ADMIN）', description: '仅允许提交到钉钉官方域名的 webhook；加签密钥可选。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['webhookUrl'],
      properties: {
        webhookUrl: { type: 'string', format: 'uri', description: '钉钉群机器人 webhook 地址（oapi.dingtalk.com 官方域名）' },
        secret: { type: 'string', description: '加签密钥（可选，用于签名校验）' },
      },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  saveDingtalk(@Req() req: any, @Body() body: { webhookUrl?: string; secret?: string }) {
    return this.integrations.saveDingtalk(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '', body?.secret)
  }

  @Delete('dingtalk')
  @Roles('ADMIN')
  @ApiOperation({ summary: '删除钉钉群机器人配置（仅 ADMIN）' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  removeDingtalk(@Req() req: any) {
    return this.integrations.deleteDingtalk(req.user.tenantId, req.user.userId)
  }

  @Post('dingtalk/test')
  @Roles('ADMIN')
  @ApiOperation({ summary: '发送钉钉测试消息（仅 ADMIN）' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  testDingtalk(@Req() req: any) {
    return this.integrations.sendDingtalkTest(req.user.tenantId, req.user.userId)
  }

  @Get('wework')
  @ApiOperation({ summary: '获取企业微信群机器人配置', description: '凭证加密存储，页面仅展示脱敏信息。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getWework(@Req() req: any) {
    return this.integrations.getWework(req.user.tenantId)
  }

  @Put('wework')
  @Roles('ADMIN')
  @ApiOperation({ summary: '保存企业微信群机器人配置（仅 ADMIN）', description: '仅允许提交到企业微信官方域名的 webhook。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['webhookUrl'],
      properties: { webhookUrl: { type: 'string', format: 'uri', description: '企业微信群机器人 webhook 地址（qyapi.weixin.qq.com 官方域名）' } },
    },
  })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  saveWework(@Req() req: any, @Body() body: { webhookUrl?: string }) {
    return this.integrations.saveWework(req.user.tenantId, req.user.userId, body?.webhookUrl ?? '')
  }

  @Delete('wework')
  @Roles('ADMIN')
  @ApiOperation({ summary: '删除企业微信群机器人配置（仅 ADMIN）' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  removeWework(@Req() req: any) {
    return this.integrations.deleteWework(req.user.tenantId, req.user.userId)
  }

  @Post('wework/test')
  @Roles('ADMIN')
  @ApiOperation({ summary: '发送企业微信测试消息（仅 ADMIN）' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  testWework(@Req() req: any) {
    return this.integrations.sendWeworkTest(req.user.tenantId, req.user.userId)
  }

  @Post('leads')
  @ApiOperation({ summary: '集成开通留资', description: '团队任意成员可提交开通/对接咨询留资。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'phone'],
      properties: {
        integration: { type: 'string', description: '目标集成（feishu/dingtalk/wework 等）' },
        name: { type: 'string', description: '联系人姓名' },
        phone: { type: 'string', description: '联系电话' },
        note: { type: 'string', description: '需求备注' },
      },
    },
  })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  createLead(
    @Req() req: any,
    @Body() body: { integration?: string; name?: string; phone?: string; note?: string },
  ) {
    return this.integrations.createLead(req.user.tenantId, req.user.userId, body || {})
  }
}
