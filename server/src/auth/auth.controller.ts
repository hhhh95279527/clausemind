// server/src/auth/auth.controller.ts
// 认证接口：注册分流、密码登录、邮箱验证码登录、刷新 Token（公开）；资料/改密（需登录）
import { Controller, Post, Body, UseGuards, Request, Get, HttpCode } from '@nestjs/common'
import { AuthService } from './auth.service'
import { LocalAuthGuard } from './guards/local-auth.guard'
import { JwtAuthGuard } from './guards/jwt-auth.guard'
import { Public } from './decorators/public.decorator'
import { VerificationCodeService } from './verification-code.service'

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
    private readonly verificationCodes: VerificationCodeService,
  ) {}

  // 注册分流：persona=PERSONAL（仅邮箱+验证码+密码）/ TEAM（加企业名/规模/职位）
  @Public()
  @Post('register')
  async register(@Request() req: any, @Body() body: {
    persona: 'PERSONAL' | 'TEAM'
    email: string
    emailCode: string
    password: string
    displayName?: string
    orgName?: string
    companySize?: string
    position?: string
  }) {
    return this.authService.register(body, clientMeta(req))
  }

  // 发送邮箱验证码（60 秒频控；dev 控制台出码/固定码 123456）
  @Public()
  @HttpCode(200)
  @Post('email-code')
  async sendEmailCode(@Body() body: { email: string }) {
    return this.verificationCodes.sendCode(body.email)
  }

  // 邮箱验证码登录：未注册邮箱自动开通 FREE 个人空间
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
