// server/src/invite/invite.controller.ts
// 邀请链接与加入审批接口：
//   GET    /api/public/invite/:token          公开：落地页查询邀请信息（无需登录）
//   POST   /api/team/invites                  负责人：生成邀请链接
//   DELETE /api/team/invites/:id              负责人：作废邀请链接
//   POST   /api/team/members/:id/approve      负责人：审批通过
//   POST   /api/team/members/:id/reject       负责人：审批拒绝
import { Controller, Delete, Get, Param, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Public } from '../auth/decorators/public.decorator'
import { Roles } from '../auth/decorators/roles.decorator'
import { InviteService } from './invite.service.js'

@ApiTags('invite')
@Controller()
export class InviteController {
  constructor(private readonly invite: InviteService) {}

  // ── 公开（落地页）──────────────────────────────────────────────────
  @Public()
  @Get('api/public/invite/:token')
  @ApiOperation({
    summary: '【公开】查询邀请链接信息',
    description: '邀请落地页使用，无需登录。仅返回企业名、邀请人、有效期等展示信息；链接失效返回 valid=false。',
  })
  @ApiParam({ name: 'token', description: '邀请链接 token' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  getPublicInvite(@Param('token') token: string) {
    return this.invite.getPublicInvite(token)
  }

  // ── 团队管理（仅负责人 ADMIN）──────────────────────────────────────
  @ApiBearerAuth('bearer')
  @Roles('ADMIN')
  @Post('api/team/invites')
  @ApiOperation({ summary: '生成团队邀请链接（仅 ADMIN）', description: '链接 7 天内有效，可被多人接受注册；接受者注册为待审批普通成员。' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  createInvite(@Req() req: any) {
    return this.invite.createInvite(req.user.tenantId, req.user.userId)
  }

  @ApiBearerAuth('bearer')
  @Roles('ADMIN')
  @Delete('api/team/invites/:id')
  @ApiOperation({ summary: '作废邀请链接（仅 ADMIN）', description: '作废后链接无法再注册；已提交的待审批申请不受影响。' })
  @ApiParam({ name: 'id', description: '邀请记录 ID' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: true } })
  revokeInvite(@Req() req: any, @Param('id') id: string) {
    return this.invite.revokeInvite(req.user.tenantId, req.user.userId, id)
  }

  @ApiBearerAuth('bearer')
  @Roles('ADMIN')
  @Post('api/team/members/:id/approve')
  @ApiOperation({ summary: '审批通过成员加入申请（仅 ADMIN）', description: '通过后成员状态变为 ACTIVE 并占用席位，可登录团队空间；席位不足时拦截。' })
  @ApiParam({ name: 'id', description: '待审批成员的用户 ID' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  approve(@Req() req: any, @Param('id') id: string) {
    return this.invite.approve(req.user.tenantId, req.user.userId, id)
  }

  @ApiBearerAuth('bearer')
  @Roles('ADMIN')
  @Post('api/team/members/:id/reject')
  @ApiOperation({ summary: '拒绝成员加入申请（仅 ADMIN）', description: '删除该待审批账号（无业务数据），对方可使用原邮箱重新申请。' })
  @ApiParam({ name: 'id', description: '待审批成员的用户 ID' })
  @ApiResponse({ status: 201, schema: { type: 'object', additionalProperties: true } })
  reject(@Req() req: any, @Param('id') id: string) {
    return this.invite.reject(req.user.tenantId, req.user.userId, id)
  }
}
