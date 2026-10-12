// server/src/auth/strategies/jwt.strategy.ts
// JWT 策略：校验 Token 并把用户身份注入 req.user
// 双体系分流：type=platform 为平台超管（platform_admins 表，无租户上下文），
// 其余为租户用户（users 表）。平台 token 由 PlatformModule 用同一 JWT_SECRET 签发。
import { Injectable, UnauthorizedException } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { config } from '../../config/index.js'

export interface JwtPayload {
  sub: string // userId | platformAdminId
  username: string
  role: string
  tenantId?: string
  type?: 'platform'
  iat?: number
  exp?: number
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.jwt.secret,
    })
  }

  async validate(payload: JwtPayload) {
    if (!payload.sub) {
      throw new UnauthorizedException('Token 无效')
    }
    // 平台超管 token：无 tenantId，role 固定 PLATFORM_ADMIN（租户用户 UserRole 枚举不含该值，无法伪造）
    if (payload.type === 'platform') {
      return {
        userId: payload.sub,
        username: payload.username,
        role: 'PLATFORM_ADMIN',
        tenantId: null,
      }
    }
    if (!payload.tenantId) {
      throw new UnauthorizedException('Token 无效')
    }
    // req.user 全应用统一结构
    return {
      userId: payload.sub,
      username: payload.username,
      role: payload.role,
      tenantId: payload.tenantId,
    }
  }
}
