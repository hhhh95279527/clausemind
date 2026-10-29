// server/src/auth/auth.controller.ts
// 认证接口：注册分流、密码登录、邮箱验证码登录、刷新 Token（公开）；资料/改密（需登录）
import { Controller, Post, Body, UseGuards, Request, Get, HttpCode, BadRequestException } from '@nestjs/common'
import { ApiBearerAuth, ApiBody, ApiOkResponse, ApiOperation, ApiResponse, ApiTags, type SchemaObject } from '@nestjs/swagger'
import { AuthService, type RegisterDto } from './auth.service'
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

// 注册请求体（与 AuthService.RegisterDto 对应；interface 无法在运行时反射，这里显式声明 schema）
const registerBodySchema: SchemaObject = {
  type: 'object',
  required: ['persona', 'username', 'email', 'password'],
  properties: {
    persona: { type: 'string', enum: ['PERSONAL', 'TEAM', 'INVITE'], description: '注册类型：PERSONAL=个人版空间，TEAM=团队演示空间，INVITE=凭团队邀请链接加入（需带 inviteToken，注册后待管理员审批）' },
    username: { type: 'string', minLength: 3, maxLength: 20, pattern: '^[a-zA-Z0-9_]{3,20}$', description: '用户名（3-20 位字母/数字/下划线，唯一）' },
    email: { type: 'string', format: 'email', description: '邮箱（仅格式校验，注册不强制验证码）' },
    password: { type: 'string', minLength: 8, description: '登录密码' },
    displayName: { type: 'string', description: '显示名称，可选' },
    orgName: { type: 'string', description: '【TEAM】企业/团队名称' },
    companySize: { type: 'string', description: '【TEAM】团队规模' },
    position: { type: 'string', description: '【TEAM】职位' },
    inviteToken: { type: 'string', description: '【INVITE】团队邀请链接中的 token' },
  },
}

// 公共用户体（与 AuthService.AuthUserPayload 对应）
const userPayloadSchema: SchemaObject = {
  type: 'object',
  required: ['id', 'username', 'role', 'tenantId', 'plan', 'workspaceType', 'couponBalance', 'onboardingCompleted', 'emailVerified'],
  properties: {
    id: { type: 'string', description: '用户 ID（cuid）' },
    username: { type: 'string', description: '用户名' },
    email: { type: ['string', 'null'], description: '邮箱，可能为 null' },
    displayName: { type: ['string', 'null'], description: '显示名称，可能为 null' },
    role: { type: 'string', enum: ['ADMIN', 'USER'] },
    tenantId: { type: 'string' },
    plan: { type: 'string', enum: ['FREE', 'TEAM', 'PERSONAL', 'ENTERPRISE'] },
    workspaceType: { type: 'string', enum: ['PERSONAL', 'TEAM'] },
    couponBalance: { type: 'number', description: '深度券余额' },
    onboardingCompleted: { type: 'boolean' },
    emailVerified: { type: 'boolean' },
  },
}

// 双 token
const tokenPairSchema: SchemaObject = {
  type: 'object',
  required: ['accessToken', 'refreshToken'],
  properties: {
    accessToken: { type: 'string', description: '访问令牌（JWT，7d）' },
    refreshToken: { type: 'string', description: '刷新令牌（JWT，30d）' },
  },
}

// 登录/注册成功体：{ user, accessToken, refreshToken }
const authLoginResponseSchema: SchemaObject = {
  type: 'object',
  required: ['user', 'accessToken', 'refreshToken'],
  properties: {
    user: userPayloadSchema,
    accessToken: { type: 'string' },
    refreshToken: { type: 'string' },
  },
}

@ApiTags('auth')
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  // 注册分流：persona=PERSONAL（用户名+邮箱+密码）/ TEAM（再加企业名/规模/职位）
  // 注册不强制邮箱验证码；邮箱归属由首次验证码登录自然验证
  @Public()
  @Post('register')
  @ApiOperation({ summary: '用户注册（个人/团队分流）', description: '注册无需邮箱验证码。PERSONAL 开通 FREE 个人空间；TEAM 开通团队版演示空间。用户名重复返回 409。' })
  @ApiBody({ schema: registerBodySchema })
  @ApiResponse({ status: 201, description: '注册成功（PERSONAL/TEAM 注册即登录）', schema: authLoginResponseSchema })
  @ApiResponse({ status: 201, description: '邀请加入待审批（INVITE，无 token）', schema: { type: 'object', properties: { pending: { type: 'boolean' }, tenantName: { type: 'string' } } } })
  async register(@Request() req: any, @Body() body: RegisterDto) {
    return this.authService.register(body, clientMeta(req))
  }

  // 发送登录用邮箱验证码：仅已绑定账号的邮箱可收（60 秒频控）
  @Public()
  @HttpCode(200)
  @Post('email-code')
  @ApiOperation({ summary: '发送登录邮箱验证码', description: '仅向已绑定账号的邮箱发送；同一邮箱 60 秒频控。dev 环境验证码打印在后端控制台。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', format: 'email', description: '已绑定账号的邮箱' } },
    },
  })
  @ApiOkResponse({ description: '发送成功', schema: { type: 'object', properties: { sent: { type: 'boolean' }, cooldownSeconds: { type: 'number' } } } })
  async sendEmailCode(@Body() body: { email: string }) {
    return this.authService.sendLoginCode(body.email)
  }

  // 邮箱验证码登录：仅已绑定该邮箱的账号可登录
  @Public()
  @HttpCode(200)
  @Post('login-by-code')
  @ApiOperation({ summary: '邮箱验证码登录', description: '仅允许已绑定邮箱的用户使用；未绑定邮箱返回错误。成功返回 accessToken / refreshToken 与用户信息。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email', 'code'],
      properties: {
        email: { type: 'string', format: 'email' },
        code: { type: 'string', description: '6 位邮箱验证码' },
      },
    },
  })
  @ApiOkResponse({ description: '登录成功', schema: authLoginResponseSchema })
  async loginByCode(
    @Request() req: any,
    @Body() body: { email: string; code: string },
  ) {
    return this.authService.loginByCode(body.email, body.code, clientMeta(req))
  }

  @Public()
  @HttpCode(200)
  @Post('login')
  @ApiOperation({ summary: '用户名密码登录', description: '账号字段可传用户名或邮箱。密码错误返回明确业务错误（不跳转登录过期）。成功返回 accessToken / refreshToken。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string', description: '用户名或邮箱' },
        password: { type: 'string', description: '登录密码' },
      },
    },
  })
  @ApiOkResponse({ description: '登录成功', schema: authLoginResponseSchema })
  async login(@Request() req: any, @Body() body: { username?: string; password?: string }) {
    // 参数格式错误返回 400（在 LocalAuthGuard 之前拦截，避免 Passport 对空值直接抛 401）
    if (!body?.username?.trim() || !body?.password?.trim()) {
      throw new BadRequestException('用户名和密码不能为空')
    }
    // 手动走 LocalStrategy 认证（复用 validateUser 逻辑）
    const user = await this.authService.validateUser(body.username.trim(), body.password)
    return this.authService.login(user, clientMeta(req))
  }

  // 忘记密码：向已绑定账号的邮箱发送一次性重置链接（15 分钟有效，60 秒频控）
  @Public()
  @HttpCode(200)
  @Post('forgot-password')
  @ApiOperation({ summary: '忘记密码（发送重置链接）', description: '向绑定邮箱发送一次性重置链接，链接 15 分钟有效；60 秒频控。无论邮箱是否存在均返回成功，防止账号枚举。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['email'],
      properties: { email: { type: 'string', format: 'email' } },
    },
  })
  @ApiOkResponse({ description: '发送成功', schema: { type: 'object', properties: { sent: { type: 'boolean' }, message: { type: 'string' } } } })
  async forgotPassword(@Body() body: { email: string }) {
    return this.authService.forgotPassword(body.email)
  }

  // 重置密码：凭邮件链接中的一次性 token 设置新密码
  @Public()
  @HttpCode(200)
  @Post('reset-password')
  @ApiOperation({ summary: '重置密码', description: '凭重置链接中的一次性 token 设置新密码；使用成功后所有旧登录凭证立即失效。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['token', 'newPassword'],
      properties: {
        token: { type: 'string', description: '重置邮件中的一次性 token' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
  })
  @ApiOkResponse({ description: '重置成功', schema: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } } })
  async resetPassword(@Body() body: { token: string; newPassword: string }) {
    return this.authService.resetPassword(body.token, body.newPassword)
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: '刷新访问令牌', description: '凭 refreshToken 换取新的 accessToken/refreshToken（refresh 轮转，旧 refreshToken 失效）。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['refreshToken'],
      properties: { refreshToken: { type: 'string' } },
    },
  })
  @ApiResponse({ status: 201, description: '刷新成功（返回新 token 对）', schema: tokenPairSchema })
  async refresh(@Request() req: any, @Body() body: { refreshToken: string }) {
    return this.authService.refreshToken(body.refreshToken, clientMeta(req))
  }

  @ApiBearerAuth('bearer')
  @UseGuards(JwtAuthGuard)
  @Get('profile')
  @ApiOperation({ summary: '获取当前登录用户资料', description: '返回用户体及其套餐、空间类型、深度券余额等信息。' })
  @ApiOkResponse({ description: '用户资料', schema: userPayloadSchema })
  async getProfile(@Request() req: any) {
    return this.authService.getProfile(req.user.userId)
  }

  // 完成新手引导（FR-3）：返回更新后的用户信息，前端据此关闭引导
  @ApiBearerAuth('bearer')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('onboarding/complete')
  @ApiOperation({ summary: '完成新手引导', description: '标记当前用户已完成新手引导，返回更新后的用户信息。' })
  @ApiOkResponse({ description: '更新后的用户资料', schema: userPayloadSchema })
  async completeOnboarding(@Request() req: any) {
    return this.authService.completeOnboarding(req.user.userId)
  }

  @ApiBearerAuth('bearer')
  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  @ApiOperation({ summary: '修改密码', description: '需校验旧密码；修改成功后旧会话凭证处理以服务端策略为准。' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['oldPassword', 'newPassword'],
      properties: {
        oldPassword: { type: 'string' },
        newPassword: { type: 'string', minLength: 8 },
      },
    },
  })
  @ApiResponse({ status: 201, description: '修改成功', schema: { type: 'object', properties: { success: { type: 'boolean' } } } })
  async changePassword(@Request() req: any, @Body() body: { oldPassword: string; newPassword: string }) {
    return this.authService.changePassword(req.user.userId, body.oldPassword, body.newPassword)
  }
}
