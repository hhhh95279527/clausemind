// server/src/tenant-templates/tenant-templates.module.ts
// 企业自有合同范本库。DatabaseService/EntitlementsService/TraceService 由全局模块提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { TenantTemplateController } from './tenant-template.controller.js'
import { TenantTemplateService } from './tenant-template.service.js'

@Module({
  imports: [AuditModule],
  controllers: [TenantTemplateController],
  providers: [TenantTemplateService],
})
export class TenantTemplatesModule {}
