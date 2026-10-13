// server/src/team/team.controller.ts
// 团队席位接口（FR-18）。成员列表团队内可见；增/改/移除仅负责人（ADMIN）。
import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { Roles } from '../auth/decorators/roles.decorator'
import { TeamService } from './team.service.js'

@ApiTags('team')
@ApiBearerAuth('bearer')
@Controller('api/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @ApiOperation({ summary: '团队成员列表', description: '团队内所有成员可见。' })
  list(@Req() req: any) {
    return this.team.listMembers(req.user.tenantId)
  }

  @Post('members')
  @Roles('ADMIN')
  @ApiOperation({ summary: '新增团队成员（仅 ADMIN）', description: '由负责人代创建成员账号（含初始密码），占用团队席位。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['displayName'],
      properties: {
        displayName: { type: 'string', description: '成员姓名/显示名' },
        email: { type: 'string', format: 'email', description: '邮箱（可选）' },
        role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'USER', 'READONLY'], description: '角色，默认 USER', default: 'USER' },
      },
    },
  })
  create(@Req() req: any, @Body() body: { displayName?: string; email?: string; role?: string }) {
    return this.team.createMember(req.user.tenantId, req.user.userId, body || {})
  }

  @Patch('members/:id/role')
  @Roles('ADMIN')
  @ApiOperation({ summary: '修改成员角色（仅 ADMIN）', description: '不能修改自己的角色，防止管理入口被锁死。' })
  @ApiParam({ name: 'id', description: '成员用户 ID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['role'],
      properties: { role: { type: 'string', enum: ['ADMIN', 'MANAGER', 'USER', 'READONLY'] } },
    },
  })
  updateRole(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { role?: string },
  ) {
    return this.team.updateRole(req.user.tenantId, req.user.userId, id, body?.role)
  }

  @Delete('members/:id')
  @Roles('ADMIN')
  @ApiOperation({ summary: '移除/禁用成员（仅 ADMIN，软删除）', description: '不能移除自己；仅将账号置为禁用，保留审计关联数据。' })
  @ApiParam({ name: 'id', description: '成员用户 ID' })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.team.removeMember(req.user.tenantId, req.user.userId, id)
  }
}
