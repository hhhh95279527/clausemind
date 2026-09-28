// server/src/integrations/crypto.util.ts
// 集成凭证对称加密（AES-256-GCM）。
// 密钥由环境变量派生：优先 INTEGRATION_SECRET，退化 JWT_SECRET（本地开发）。
// 生产环境两者缺失时启动即失败；本地开发允许固定开发密钥（仅控制台告警）。
// 密文格式：v1.<iv b64>.<tag b64>.<ciphertext b64>
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import { logger } from '../utils/logger.js'

const PREFIX = 'v1'
const FALLBACK_SECRET = 'workmind-dev-integration'

@Injectable()
export class IntegrationCryptoService {
  private readonly key: Buffer

  constructor() {
    const env = process.env.NODE_ENV ?? 'development'
    let secret = process.env.INTEGRATION_SECRET || process.env.JWT_SECRET
    if (!secret) {
      if (env === 'production') {
        // 禁止生产使用硬编码兜底密钥：集成凭证必须有真实密钥才能启动
        throw new Error('安全校验失败：生产环境必须设置 INTEGRATION_SECRET 或 JWT_SECRET')
      }
      secret = FALLBACK_SECRET
      logger.warn('integration crypto using insecure dev fallback secret; do not use in production')
    }
    this.key = createHash('sha256').update(secret).digest()
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${PREFIX}.${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`
  }

  decrypt(payload: string): string {
    const parts = payload.split('.')
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new Error('不支持的凭证格式')
    }
    const [, ivB64, tagB64, ctB64] = parts
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB64, 'base64'))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}
