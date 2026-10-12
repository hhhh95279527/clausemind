// server/src/billing/entitlements.module.ts
// 权益模块：全局可用（DatabaseModule 同款 @Global），导出 EntitlementsService
import { Global, Module } from '@nestjs/common'
import { EntitlementsService } from './entitlements.service.js'
import { TrialService } from './trial.service.js'

@Global()
@Module({
  providers: [EntitlementsService, TrialService],
  exports: [EntitlementsService, TrialService],
})
export class EntitlementsModule {}
