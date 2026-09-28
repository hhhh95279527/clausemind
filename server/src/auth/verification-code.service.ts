// server/src/auth/verification-code.service.ts
// 邮箱验证码（FR-4）：
// - 6 位数字，5 分钟有效；同邮箱 60 秒重发频控（Redis 键 TTL 实现）
// - dev（MAILER_CONSOLE）：固定码 123456 始终可用，真实随机码同时写 Redis 并打印控制台
// - 校验通过即删码（一次性）；错误码/过期/超频均给出明确错误
import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common'
import { RedisService } from '../redis/redis.service.js'
import { config } from '../config/index.js'
import { MailerService } from './mailer.service.js'

const CODE_TTL_SECONDS = 5 * 60     // 5 分钟有效
const RESEND_INTERVAL_SECONDS = 60 // 60 秒重发频控
const MAX_VERIFY_ATTEMPTS = 5       // 错误尝试上限，防爆破

@Injectable()
export class VerificationCodeService {
  constructor(
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
  ) {}

  private codeKey(email: string) {
    return `vcode:${email.toLowerCase()}`
  }

  private rateKey(email: string) {
    return `vcode:rl:${email.toLowerCase()}`
  }

  private attemptsKey(email: string) {
    return `vcode:att:${email.toLowerCase()}`
  }

  /** 生成并发送验证码；60 秒内重复请求抛 429 */
  async sendCode(email: string): Promise<{ sent: true; cooldownSeconds: number }> {
    const normalized = this.normalizeEmail(email)
    const rateKey = this.rateKey(normalized)

    // SET NX PX：仅当频控键不存在时写入成功，原子防并发
    const allowed = await this.redis.getClient().set(
      rateKey, '1', 'EX', RESEND_INTERVAL_SECONDS, 'NX',
    )
    if (allowed !== 'OK') {
      const ttl = await this.redis.getClient().ttl(rateKey)
      // NestJS 10 无 TooManyRequestsException（v11 才有），直接抛 429
      throw new HttpException(
        { message: `发送过于频繁，请 ${ttl > 0 ? ttl : RESEND_INTERVAL_SECONDS} 秒后再试` },
        HttpStatus.TOO_MANY_REQUESTS,
      )
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    await this.redis.set(this.codeKey(normalized), code, CODE_TTL_SECONDS * 1000)
    // 重置错误计数，与验证码同生命周期
    await this.redis.set(this.attemptsKey(normalized), '0', CODE_TTL_SECONDS * 1000)

    await this.mailer.sendVerificationCode(normalized, code, CODE_TTL_SECONDS / 60)
    return { sent: true, cooldownSeconds: RESEND_INTERVAL_SECONDS }
  }

  /**
   * 校验验证码（一次性，通过即删）。
   * dev 控制台模式额外接受固定码（固定码用过后不删除真实码）。
   * 错误码累计 5 次失效。
   */
  async verifyCode(email: string, code: string): Promise<void> {
    const normalized = this.normalizeEmail(email)
    const trimmed = (code || '').trim()
    if (!/^\d{6}$/.test(trimmed)) {
      throw new BadRequestException('验证码为 6 位数字')
    }

    // dev 固定码通道（双保险：除开关外，生产环境硬禁用）
    if (
      config.mailer.console &&
      config.app.env !== 'production' &&
      trimmed === config.mailer.fixedCode
    ) {
      return
    }

    const stored = await this.redis.get(this.codeKey(normalized))
    if (!stored) {
      throw new BadRequestException('验证码已过期或未发送，请重新获取')
    }

    if (stored !== trimmed) {
      const client = this.redis.getClient()
      const attempts = Number((await client.get(this.attemptsKey(normalized))) ?? '0') + 1
      if (attempts >= MAX_VERIFY_ATTEMPTS) {
        await Promise.all([
          this.redis.del(this.codeKey(normalized)),
          this.redis.del(this.attemptsKey(normalized)),
        ])
        throw new BadRequestException('验证码错误次数过多，已失效，请重新获取')
      }
      await this.redis.set(this.attemptsKey(normalized), String(attempts), CODE_TTL_SECONDS * 1000)
      throw new BadRequestException('验证码错误')
    }

    // 校验通过：一次性销毁
    await Promise.all([
      this.redis.del(this.codeKey(normalized)),
      this.redis.del(this.attemptsKey(normalized)),
    ])
  }

  private normalizeEmail(email: string): string {
    const v = (email || '').trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      throw new BadRequestException('邮箱格式不正确')
    }
    return v
  }
}
