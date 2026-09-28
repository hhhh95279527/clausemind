// server/src/services/feishu/feishu.module.ts
import { Module } from '@nestjs/common'
import { IntegrationCryptoService } from '../../integrations/crypto.util.js'
import { NotificationsModule } from '../../notifications/notifications.module.js'
import { FeishuNotifyService } from './feishu-notify.service.js'
import { NotifyDigestService } from './notify-digest.service.js'

@Module({
  imports: [NotificationsModule],
  providers: [IntegrationCryptoService, FeishuNotifyService, NotifyDigestService],
  exports: [FeishuNotifyService],
})
export class FeishuModule {}
