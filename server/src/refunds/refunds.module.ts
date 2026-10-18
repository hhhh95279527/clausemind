// server/src/refunds/refunds.module.ts
// 退款工单模块：用户端 + 平台超管端。DatabaseService/EntitlementsService/TraceService 由全局模块提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { RefundsController, RefundsAdminController } from './refunds.controller.js'
import { RefundsService } from './refunds.service.js'

@Module({
  imports: [AuditModule],
  controllers: [RefundsController, RefundsAdminController],
  providers: [RefundsService],
})
export class RefundsModule {}
