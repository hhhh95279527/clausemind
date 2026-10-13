// server/src/auth/strategies/local.strategy.ts
// 本地策略：用户名+密码验证
import { Injectable } from '@nestjs/common'
import { PassportStrategy } from '@nestjs/passport'
import { Strategy } from 'passport-local'
import { AuthService } from '../auth.service'

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(private authService: AuthService) {
    super({ usernameField: 'username' })
  }

  async validate(username: string, password: string): Promise<any> {
    return this.authService.validateUser(username, password)
  }
}
