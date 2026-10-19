// server/src/billing/orders.controller.ts
// 模拟收银台接口（FR-13）：
//   POST   /api/billing/orders                    创建模拟订单（PENDING）
//   GET    /api/billing/orders                    订单记录
//   POST   /api/billing/orders/:id/mock-pay       模拟支付，立即生效
//   POST   /api/billing/subscription/cancel       取消订阅（二次确认）
//   POST   /api/billing/enterprise-lead           企业版/席位增购留资
import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { OrdersService, type PayChannel } from './orders.service.js'

const CHECKOUT_ITEMS = ['PERSONAL_MONTHLY', 'PERSONAL_YEARLY', 'COUPON_PACK', 'TEAM_MONTHLY']

@ApiTags('billing')
@ApiBearerAuth('bearer')
@Controller('api/billing')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders')
  @ApiOperation({
    summary: '创建订单',
    description: '按服务端商品目录下单（价格由后端配置决定，禁止客户端传价）。商品：PERSONAL_MONTHLY/PERSONAL_YEARLY（个人版订阅）、COUPON_PACK（10 张深度券包）、TEAM_MONTHLY（团队版升级）。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['item'],
      properties: { item: { type: 'string', enum: CHECKOUT_ITEMS, description: '商品编码' } },
    },
  })
  async create(@Req() req: any, @Body() body: { item?: string }) {
    const order = await this.orders.createOrder(
      req.user.tenantId,
      req.user.userId,
      (body.item || '').toUpperCase(),
    )
    // NestJS POST 默认 201 Created
    return { order }
  }

  @Get('orders')
  @ApiOperation({ summary: '订单记录', description: '返回当前租户的订单列表（含订阅、券包、升级单）。' })
  async list(@Req() req: any) {
    return { orders: await this.orders.listOrders(req.user.tenantId) }
  }

  @Post('orders/:id/mock-pay')
  @ApiOperation({ summary: '模拟支付（演示环境）', description: '演示用：立即确认支付并开通/续费对应套餐或券包。续费自原到期日顺延。' })
  @ApiParam({ name: 'id', description: '订单 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: { channel: { type: 'string', enum: ['WECHAT', 'ALIPAY'], description: '支付渠道，默认 WECHAT', default: 'WECHAT' } },
    },
  })
  async pay(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { channel?: string },
  ) {
    const channel: PayChannel = body.channel === 'ALIPAY' ? 'ALIPAY' : 'WECHAT'
    const result = await this.orders.mockPay(req.user.tenantId, req.user.userId, id, channel)
    return { statusCode: 201, ...result }
  }

  @Post('subscription/cancel')
  @ApiOperation({ summary: '取消订阅', description: '需二次确认：confirm=true 才真正取消；到期后空间降级为 FREE。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['confirm'],
      properties: { confirm: { type: 'boolean', description: '必须为 true 才执行取消' } },
    },
  })
  async cancel(@Req() req: any, @Body() body: { confirm?: boolean }) {
    return this.orders.cancelSubscription(req.user.tenantId, req.user.userId, body.confirm === true)
  }

  @Post('enterprise-lead')
  @ApiOperation({
    summary: '企业版开通/增购咨询留资',
    description: '公开定价页与「我的套餐」页共用。提交后异步发送通知邮件给管理员，发送失败不影响提交结果。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['company', 'contact'],
      properties: {
        company: { type: 'string', description: '企业名称' },
        teamSize: { type: 'string', description: '团队规模' },
        contact: { type: 'string', description: '联系方式（手机号/邮箱/微信等）' },
        note: { type: 'string', description: '咨询内容备注' },
      },
    },
  })
  async lead(
    @Req() req: any,
    @Body() body: { company?: string; teamSize?: string; contact?: string; note?: string },
  ) {
    return this.orders.createEnterpriseLead(req.user.tenantId, req.user.userId, body)
  }

  // ── 转账支付（人工确认）────────────────────────────────────────
  // 收款信息（管理员收款码等），登录即可读
  @Get('payment-info')
  @ApiOperation({ summary: '转账收款信息', description: '返回收银台「银行转账」页签展示的收款码/收款说明。' })
  paymentInfo() {
    return this.orders.getPaymentInfo()
  }

  /** 收银台支付模式：白名单账号可模拟支付，其余账号仅真实转账 */
  @Get('pay-options')
  @ApiOperation({ summary: '收银台支付模式', description: '返回当前账号是否可模拟支付（simulatePay）。' })
  async payOptions(@Req() req: any) {
    return this.orders.getPayOptions(req.user.userId)
  }

  // 提交转账订单（multipart：item/channel/transferNo + proof 截图 ≤3 张），等待超管确认到账
  @Post('transfer-orders')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: '提交转账支付订单',
    description: '提交转账单号 + 可选凭证截图后等待平台超管人工确认到账；确认后开通对应套餐。同一转账单号重复提交会被拦截。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['item', 'transferNo'],
      properties: {
        item: { type: 'string', enum: CHECKOUT_ITEMS, description: '商品编码' },
        channel: { type: 'string', enum: ['WECHAT', 'ALIPAY', 'BANK'], description: '转账渠道' },
        transferNo: { type: 'string', description: '转账凭证单号/流水号' },
        proof: { type: 'array', items: { type: 'string', format: 'binary' }, description: '转账截图（≤3 张，单张 ≤10MB）' },
      },
    },
  })
  async submitTransfer(
    @Req() req: any,
    @Body() body: { item?: string; channel?: string; transferNo?: string },
  ) {
    return this.orders.createTransferOrder(req.user.tenantId, req.user.userId, body, req.files)
  }

  /** 下载转账凭证截图（按 index） */
  @Get('transfer-orders/:id/proof/:index')
  @ApiOperation({ summary: '下载转账凭证截图', description: '按截图下标下载转账凭证图片（0 起）。' })
  @ApiParam({ name: 'id', description: '订单 ID' })
  @ApiParam({ name: 'index', description: '凭证下标' })
  async downloadProof(
    @Param('id') id: string,
    @Param('index') index: string,
    @Res() res: any,
  ) {
    const { filePath, fileName } = await this.orders.getTransferProof(id, index)
    res.download(filePath, fileName)
  }
}
