// server/src/analytics/analytics.module.ts
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { config } from '../config/index.js'
import { AnalyticsController } from './analytics.controller.js'
import { AnalyticsService } from './analytics.service.js'

@Module({
  imports: [
    JwtModule.register({
      secret: config.jwt.secret,
    }),
  ],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
