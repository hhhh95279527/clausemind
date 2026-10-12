// server/src/services/dingtalk/dingtalk.module.ts
import { Module } from '@nestjs/common'
import { IntegrationCryptoService } from '../../integrations/crypto.util.js'
import { DingtalkNotifyService } from './dingtalk-notify.service.js'

@Module({
  providers: [IntegrationCryptoService, DingtalkNotifyService],
  exports: [DingtalkNotifyService],
})
export class DingtalkModule {}
