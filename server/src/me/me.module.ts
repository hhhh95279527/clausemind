// server/src/me/me.module.ts
// 个人空间资料模块（权益快照 / 审查偏好 / 个人条款库）；DB 与 Entitlements 由全局模块提供
import { Module } from '@nestjs/common'
import { MeController } from './me.controller.js'

@Module({
  controllers: [MeController],
})
export class MeModule {}
