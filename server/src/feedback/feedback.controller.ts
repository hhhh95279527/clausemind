// server/src/feedback/feedback.controller.ts
// 建议反馈接口（/api/feedback）。个人版与企业版租户用户均可提交。
import { Body, Controller, Post, Req } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger'
import { FeedbackService } from './feedback.service.js'

@ApiTags('feedback')
@ApiBearerAuth('bearer')
@Controller('api/feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  @ApiOperation({
    summary: '提交建议反馈',
    description:
      '个人版/企业版登录用户均可提交。内容落库留底，并异步发送通知邮件到平台反馈邮箱；邮件发送失败不影响提交结果。单用户每日限 5 条。',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['content'],
      properties: {
        category: {
          type: 'string',
          enum: ['FEATURE', 'BUG', 'EXPERIENCE', 'OTHER'],
          description: '建议类型：功能建议 / 问题反馈 / 体验优化 / 其他，缺省 OTHER',
        },
        content: { type: 'string', description: '建议内容（5~1000 字）' },
        contact: { type: 'string', description: '联系方式（可选，手机/邮箱/微信等，最多 100 字）' },
      },
    },
  })
  create(
    @Req() req: any,
    @Body() body: { category?: string; content?: string; contact?: string },
  ) {
    return this.feedback.create(req.user.tenantId, req.user.userId, body || {})
  }
}
