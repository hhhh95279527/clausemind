// server/src/team/team.module.ts
// 团队席位与成员管理（FR-18）。EntitlementsService 由全局 EntitlementsModule 提供。
import { Module } from '@nestjs/common'
import { AuditModule } from '../audit/audit.module.js'
import { TeamController } from './team.controller.js'
import { TeamService } from './team.service.js'

@Module({
  imports: [AuditModule],
  controllers: [TeamController],
  providers: [TeamService],
})
export class TeamModule {}
