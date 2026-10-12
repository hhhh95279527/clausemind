// server/src/auth/auth.controller.ts
// 认证接口：注册分流、密码登录、邮箱验证码登录、刷新 Token（公开）；资料/改密（需登录）
import { Controller, Post, Body, UseGuards, Request, Get, HttpCode } from '@nestjs/common'
import { AuthService } from './auth.service'
import { LocalAuthGuard } from './guards/local-auth.guard'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { Public } from './decorators/public.decorator'

/** 提取客户端元信息（trust proxy 开启后 req.ip 取 X-Forwarded-For 对端） */
function clientMeta(req: any) {
  return {
    ip: req.ip ?? req.socket?.remoteAddress,
    userAgent: req.headers?.['user-agent'] as string | undefined,
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  // 注册分流：persona=PERSONAL（用户名+邮箱+密码）/ TEAM（再加企业名/规模/职位）
  // 注册不强制邮箱验证码；邮箱归属由首次验证码登录自然验证
  @Public()
  @Post('register')
  async register(@Request() req: any, @Body() body: {
    persona: 'PERSONAL' | 'TEAM'
    username: string
    email: string
    password: string
    displayName?: string
    orgName?: string
    companySize?: string
    position?: string
  }) {
    return this.authService.register(body, clientMeta(req))
  }

  // 发送登录用邮箱验证码：仅已绑定账号的邮箱可收（60 秒频控）
  @Public()
  @HttpCode(200)
  @Post('email-code')
  async sendEmailCode(@Body() body: { email: string }) {
    return this.authService.sendLoginCode(body.email)
  }

  // 邮箱验证码登录：仅已绑定该邮箱的账号可登录
  @Public()
  @HttpCode(200)
  @Post('login-by-code')
  async loginByCode(
    @Request() req: any,
    @Body() body: { email: string; code: string },
  ) {
    return this.authService.loginByCode(body.email, body.code, clientMeta(req))
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @HttpCode(200)
  @Post('login')
  async login(@Request() req: any) {
    return this.authService.login(req.user, clientMeta(req))
  }

  // 忘记密码：向已绑定账号的邮箱发送一次性重置链接（15 分钟有效，60 秒频控）
  @Public()
  @HttpCode(200)
  @Post('forgot-password')
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email)
  }

  // 重置密码：凭邮件链接中的一次性 token 设置新密码
  @Public()
  @HttpCode(200)
  @Post('reset-password')
  async resetPassword(@Body() body: { token: string; newPassword: string }) {
    return this.authService.resetPassword(body.token, body.newPassword)
  }

  @Public()
  @Post('refresh')
  async refresh(@Request() req: any, @Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken, clientMeta(req))
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.userId)
  }

  // 完成新手引导（FR-3）：返回更新后的用户信息，前端据此关闭引导
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('onboarding/complete')
  async completeOnboarding(@Request() req: any) {
    return this.authService.completeOnboarding(req.user.userId)
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(@Request() req: any, @Body() body: { oldPassword: string; newPassword: string }) {
    return this.authService.changePassword(req.user.userId, body.oldPassword, body.newPassword)
  }
}
