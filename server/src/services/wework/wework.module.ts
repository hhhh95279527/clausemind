// server/src/services/wework/wework.module.ts
import { Module } from '@nestjs/common'
import { IntegrationCryptoService } from '../../integrations/crypto.util.js'
import { WeworkNotifyService } from './wework-notify.service.js'

@Module({
  providers: [IntegrationCryptoService, WeworkNotifyService],
  exports: [WeworkNotifyService],
})
export class WeworkModule {}
