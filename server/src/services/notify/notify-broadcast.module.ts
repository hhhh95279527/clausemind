// server/src/services/notify/notify-broadcast.module.ts
import { Module } from '@nestjs/common'
import { FeishuModule } from '../feishu/feishu.module.js'
import { DingtalkModule } from '../dingtalk/dingtalk.module.js'
import { WeworkModule } from '../wework/wework.module.js'
import { NotifyBroadcastService } from './notify-broadcast.service.js'

@Module({
  imports: [FeishuModule, DingtalkModule, WeworkModule],
  providers: [NotifyBroadcastService],
  exports: [NotifyBroadcastService],
})
export class NotifyBroadcastModule {}
