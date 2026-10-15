// server/src/feedback/feedback.module.ts
// 建议反馈模块。AuditService 由 AuditModule 提供；MailerService 由 AuthModule 导出。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { FeedbackController } from './feedback.controller.js'
import { FeedbackService } from './feedback.service.js'

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
