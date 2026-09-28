// server/src/team/team.controller.ts
// 团队席位接口（FR-18）。成员列表团队内可见；增/改/移除仅负责人（ADMIN）。
import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common'
import { Roles } from '../auth/decorators/roles.decorator'
import { TeamService } from './team.service.js'

@Controller('api/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  list(@Req() req: any) {
    return this.team.listMembers(req.user.tenantId)
  }

  @Post('members')
  @Roles('ADMIN')
  create(@Req() req: any, @Body() body: { displayName?: string; email?: string; role?: string }) {
    return this.team.createMember(req.user.tenantId, req.user.userId, body || {})
  }

  @Patch('members/:id/role')
  @Roles('ADMIN')
  updateRole(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { role?: string },
  ) {
    return this.team.updateRole(req.user.tenantId, req.user.userId, id, body?.role)
  }

  @Delete('members/:id')
  @Roles('ADMIN')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.team.removeMember(req.user.tenantId, req.user.userId, id)
  }
}
