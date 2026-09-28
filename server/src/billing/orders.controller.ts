// server/src/billing/orders.controller.ts
// 模拟收银台接口（FR-13）：
//   POST   /api/billing/orders                    创建模拟订单（PENDING）
//   GET    /api/billing/orders                    订单记录
//   POST   /api/billing/orders/:id/mock-pay       模拟支付，立即生效
//   POST   /api/billing/subscription/cancel       取消订阅（二次确认）
//   POST   /api/billing/enterprise-lead           企业版/席位增购留资
import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common'
import { OrdersService, type PayChannel } from './orders.service.js'

@Controller('api/billing')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post('orders')
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
  async list(@Req() req: any) {
    return { orders: await this.orders.listOrders(req.user.tenantId) }
  }

  @Post('orders/:id/mock-pay')
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
  async cancel(@Req() req: any, @Body() body: { confirm?: boolean }) {
    return this.orders.cancelSubscription(req.user.tenantId, req.user.userId, body.confirm === true)
  }

  @Post('enterprise-lead')
  async lead(
    @Req() req: any,
    @Body() body: { company?: string; teamSize?: string; contact?: string; note?: string },
  ) {
    return this.orders.createEnterpriseLead(req.user.tenantId, req.user.userId, body)
  }
}
