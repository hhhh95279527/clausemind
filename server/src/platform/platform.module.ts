// server/src/platform/platform.module.ts
// 平台超管模块：独立账号体系（platform_admins 表）+ 跨租户管理
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PlatformController } from './platform.controller.js'
import { PlatformService } from './platform.service.js'
import { BillingModule } from '../billing/billing.module.js'
import { config } from '../config/index.js'

@Module({
  imports: [
    BillingModule,
    JwtModule.register({
      secret: config.jwt.secret,
      signOptions: { expiresIn: config.jwt.expiresIn as any },
    }),
  ],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
