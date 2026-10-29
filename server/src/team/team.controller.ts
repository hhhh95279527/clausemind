// server/src/team/team.controller.ts
// 团队席位接口（FR-18）。成员列表团队内可见；改/移除仅负责人（ADMIN）。
// 邀请成员与加入审批见 invite 模块（/api/team/invites、/api/team/members/:id/approve）。
import { Body, Controller, Delete, Get, Param, Patch, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { Roles } from '../auth/decorators/roles.decorator'
import { TeamService } from './team.service.js'

@ApiTags('team')
@ApiBearerAuth('bearer')
@Controller('api/team')
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  @ApiOperation({ summary: '团队成员列表', description: '团队内所有成员可见（含待审批成员，status=PENDING）。' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  list(@Req() req: any) {
    return this.team.listMembers(req.user.tenantId)
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
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
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  remove(@Req() req: any, @Param('id') id: string) {
    return this.team.removeMember(req.user.tenantId, req.user.userId, id)
  }
}
