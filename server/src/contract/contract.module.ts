// server/src/contract/contract.module.ts
// 合同风险审查业务模块（业务层）：平台能力（DB/Trace/Quota/Queue/Entitlements）由全局模块提供
import { Module } from '@nestjs/common'
import { ContractController } from './contract.controller.js'
import { ContractParseService } from './parsing/contract-parse.service.js'
import { OnboardingService } from './onboarding/onboarding.service.js'
import { ContractAssistantService } from './assistant/contract-assistant.service.js'
import { RevisionService } from './review/revision.service.js'
import { RevisionController } from './review/revision.controller.js'
import { RetentionService } from './retention/retention.service.js'
import { StructuredService } from './review/structured.service.js'
import { AuditModule } from '../audit/audit.module.js'
import { FeishuModule } from '../services/feishu/feishu.module.js'

@Module({
  imports: [AuditModule, FeishuModule],
  controllers: [ContractController, RevisionController],
  providers: [
    ContractParseService,
    OnboardingService,
    ContractAssistantService,
    RevisionService,
    RetentionService,
    StructuredService,
  ],
})
export class ContractModule {}
