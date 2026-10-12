// server/src/billing/billing.module.ts
// 订单/券包/模拟收银台 + 订阅到期降级（FR-13）。
// EntitlementsService 由全局 EntitlementsModule 提供；AuditService 需导入 AuditModule。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { OrdersController } from './orders.controller.js'
import { OrdersService } from './orders.service.js'
import { SubscriptionLifecycleService } from './subscription-lifecycle.service.js'

// TrialService 由全局 EntitlementsModule 提供，此处无需重复注册
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [OrdersController],
  providers: [OrdersService, SubscriptionLifecycleService],
  exports: [OrdersService],
})
export class BillingModule {}
