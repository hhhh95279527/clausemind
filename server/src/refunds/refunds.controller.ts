// server/src/refunds/refunds.controller.ts
// 退款工单用户端接口（/api/refunds）：
//   POST   /                        创建退款申请（multipart：files ≤5 份 ≤10MB + orderId/reason/description）
//   GET    /                        我的退款申请
//   GET    /:id                     工单详情 + 会话消息
//   POST   /:id/messages            发送消息（CHAT 状态触发 AI 回复，可自动升级人工）
//   POST   /:id/escalate            主动转人工（CHAT → AGENT）
//   GET    /:id/attachments/:index  下载附件
import {
  BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res,
} from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger'
import { RefundsService } from './refunds.service.js'

@ApiTags('refunds')
@ApiBearerAuth('bearer')
@Controller('api/refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Post()
  @ApiOperation({
    summary: '创建退款申请（multipart）',
    description: '仅 PAID 订单可申请，每笔订单仅一次。附件 ≤5 份、单份 ≤10MB。AI 可用时进入 AI 客服接待，否则直接进入人工队列。',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['orderId', 'reason'],
      properties: {
        orderId: { type: 'string', description: '订单 ID' },
        reason: { type: 'string', enum: ['MISBUY', 'DUPLICATE', 'NOT_AS_EXPECTED', 'OTHER'], description: '退款原因' },
        description: { type: 'string', maxLength: 1000, description: '补充说明' },
        files: { type: 'array', items: { type: 'string', format: 'binary' }, description: '附件（≤5 份，单份 ≤10MB）' },
      },
    },
  })
  create(
    @Req() req: any,
    @Body() body: { orderId?: string; reason?: string; description?: string },
  ) {
    return this.refunds.create(req.user.tenantId, req.user.userId, body, req.files)
  }

  @Get()
  @ApiOperation({ summary: '我的退款申请', description: '当前用户提交的退款工单（新→旧）。' })
  listMine(@Req() req: any) {
    return this.refunds.listMine(req.user.tenantId, req.user.userId)
  }

  @Get(':id')
  @ApiOperation({ summary: '工单详情与会话', description: '退款工单详情、订单摘要与会话消息（非本人/跨租户 404）。' })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  detail(@Req() req: any, @Param('id') id: string) {
    return this.refunds.detailForUser(req.user.tenantId, req.user.userId, id)
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: '发送会话消息',
    description: 'CHAT 状态触发 AI 客服回复（命中升级关键词或 AI 判定超政策会自动转人工）；AGENT 状态仅入队等待人工回复。',
  })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string', maxLength: 1000, description: '消息内容' } },
    },
  })
  sendMessage(@Req() req: any, @Param('id') id: string, @Body() body: { content?: string }) {
    return this.refunds.sendUserMessage(req.user.tenantId, req.user.userId, id, body.content || '')
  }

  @Post(':id/escalate')
  @ApiOperation({ summary: '转人工客服', description: 'CHAT → AGENT，由平台人工客服继续处理。' })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  escalate(@Req() req: any, @Param('id') id: string) {
    return this.refunds.escalate(req.user.tenantId, req.user.userId, id)
  }

  @Get(':id/attachments/:index')
  @ApiOperation({ summary: '下载附件', description: '按附件下标下载（0 起）；非本人 404。' })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  @ApiParam({ name: 'index', description: '附件下标' })
  async download(
    @Req() req: any,
    @Param('id') id: string,
    @Param('index') index: string,
    @Res() res: any,
  ) {
    const { filePath, fileName } = await this.refunds.getUserAttachment(req.user.tenantId, req.user.userId, id, index)
    res.download(filePath, fileName)
  }
}

// ── 平台超管端：/api/platform/refunds ─────────────────────────────────────

@ApiTags('platform-refunds')
@ApiBearerAuth('platform')
@Controller('api/platform/refunds')
export class RefundsAdminController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @ApiOperation({ summary: '退款工单列表', description: '跨租户全部退款工单（含租户/申请人/订单摘要），可按状态过滤。' })
  @ApiQuery({ name: 'status', enum: ['CHAT', 'AGENT', 'RESOLVED'], required: false, description: '状态过滤，缺省全部' })
  list(@Query('status') status?: string) {
    return this.refunds.listForPlatform(status)
  }

  @Get(':id')
  @ApiOperation({ summary: '工单详情与会话', description: '退款工单详情、会话消息与租户权益快照。' })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  detail(@Param('id') id: string) {
    return this.refunds.detailForPlatform(id)
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: '人工客服回复',
    description: '以人工客服身份回复用户；CHAT 状态的工单会自动切入 AGENT。RESOLVED 工单不可回复。',
  })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['content'],
      properties: { content: { type: 'string', maxLength: 1000, description: '回复内容' } },
    },
  })
  reply(@Param('id') id: string, @Req() req: any, @Body() body: { content?: string }) {
    return this.refunds.agentReply(id, (req as any).user?.username || 'platform', body.content || '')
  }

  @Post(':id/resolve')
  @ApiOperation({
    summary: '处理工单（同意退款/拒绝）',
    description: 'APPROVE：订单标 REFUNDED + 权益立即降级；真实转账订单必须提供回款转账单号。REJECT：需填写原因。工单进入终态。',
  })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['decision'],
      properties: {
        decision: { type: 'string', enum: ['APPROVE', 'REJECT'], description: '处理决定' },
        note: { type: 'string', maxLength: 500, description: '处理备注（拒绝时必填）' },
        refundTransferNo: { type: 'string', maxLength: 100, description: '回款转账单号（真实订单同意退款时必填）' },
      },
    },
  })
  resolve(
    @Param('id') id: string,
    @Req() req: any,
    @Body() body: { decision?: string; note?: string; refundTransferNo?: string },
  ) {
    const decision = body.decision === 'APPROVE' ? 'APPROVE' : body.decision === 'REJECT' ? 'REJECT' : null
    if (!decision) throw new BadRequestException('decision 必须为 APPROVE 或 REJECT')
    return this.refunds.resolve(id, (req as any).user?.username || 'platform', decision, body.note, body.refundTransferNo)
  }

  @Get(':id/attachments/:index')
  @ApiOperation({ summary: '下载附件', description: '按附件下标下载（0 起）。' })
  @ApiParam({ name: 'id', description: '退款工单 ID' })
  @ApiParam({ name: 'index', description: '附件下标' })
  async download(@Param('id') id: string, @Param('index') index: string, @Res() res: any) {
    const { filePath, fileName } = await this.refunds.getPlatformAttachment(id, index)
    res.download(filePath, fileName)
  }
}
