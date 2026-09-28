// server/src/integrations/integrations.module.ts
// 集成中心（飞书群机器人 + 其余「联系开通」留资）。
// EntitlementsService 由全局 EntitlementsModule 提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { IntegrationCryptoService } from './crypto.util.js'
import { IntegrationsController } from './integrations.controller.js'
import { IntegrationsService } from './integrations.service.js'

@Module({
  imports: [AuditModule],
  controllers: [IntegrationsController],
  providers: [IntegrationCryptoService, IntegrationsService],
})
export class IntegrationsModule {}
