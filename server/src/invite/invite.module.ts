// server/src/invite/invite.module.ts
// 团队邀请链接与加入审批。AuditService 由 AuditModule 提供；MailerService 由 AuthModule 导出；
// EntitlementsService 来自全局 EntitlementsModule。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { AuthModule } from '../auth/auth.module.js'
import { InviteController } from './invite.controller.js'
import { InviteService } from './invite.service.js'

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [InviteController],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
