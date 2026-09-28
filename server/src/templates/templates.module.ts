// server/src/templates/templates.module.ts
// 合同范本库（FR-20）。EntitlementsService 由全局 EntitlementsModule 提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { TemplateController } from './template.controller.js'
import { TemplateService } from './template.service.js'

@Module({
  imports: [AuditModule],
  controllers: [TemplateController],
  providers: [TemplateService],
})
export class TemplatesModule {}
