// server/src/auth/auth.module.ts
// 认证模块：JWT + 本地策略（账号密码）
import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { PassportModule } from '@nestjs/passport'
import { AuthService } from './auth.service'
import { AuthController } from './auth.controller'
import { JwtStrategy } from './strategies/jwt.strategy'
import { LocalStrategy } from './strategies/local.strategy'
import { MailerService } from './mailer.service'
import { VerificationCodeService } from './verification-code.service'
import { config } from '../config/index.js'

@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: config.jwt.secret,
      // ms 字符串（如 '7d'）；@nestjs/jwt 用模板字面量类型，env 读取的 string 需断言
      signOptions: { expiresIn: config.jwt.expiresIn as any },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, LocalStrategy, MailerService, VerificationCodeService],
  exports: [AuthService, MailerService, VerificationCodeService],
})
export class AuthModule {}
