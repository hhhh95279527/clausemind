// server/src/playbook/playbook.module.ts
// 企业 Playbook（FR-17）。EntitlementsService 由全局 EntitlementsModule 提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { PlaybookController } from './playbook.controller.js'
import { PlaybookService } from './playbook.service.js'

@Module({
  imports: [AuditModule],
  controllers: [PlaybookController],
  providers: [PlaybookService],
  exports: [PlaybookService],
})
export class PlaybookModule {}
