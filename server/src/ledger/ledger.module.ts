// server/src/ledger/ledger.module.ts
// 合同台账（FR-16）。EntitlementsService 由全局 EntitlementsModule 提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { LedgerController } from './ledger.controller.js'
import { LedgerService } from './ledger.service.js'

@Module({
  imports: [AuditModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
