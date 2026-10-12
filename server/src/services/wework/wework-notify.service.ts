// server/src/services/wework/wework-notify.service.ts
// 企业微信群机器人通知：审查终审通过 / 额度 80% / 每日 digest 推送（与飞书、钉钉并行）。
// 凭证存于 IntegrationConfig.config jsonb 的 weworkWebhookCipher 子键。
// 企业微信机器人无加签机制；失败均返回 {ok:false,reason}，绝不向业务链路抛异常。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service.js'
import { RedisService } from '../../redis/redis.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { IntegrationCryptoService } from '../../integrations/crypto.util.js'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

export interface WeworkSendResult {
  ok: boolean
  /** not_configured / cipher_error / network_error / upstream_<code> / db_error */
  reason?: string
}

const FETCH_TIMEOUT_MS = 8000

@Injectable()
export class WeworkNotifyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
    private readonly crypto: IntegrationCryptoService,
  ) {}

  /** 向租户配置的企微群发送 markdown 消息；未配置/失败均不抛异常 */
  async sendMarkdown(tenantId: string, title: string, lines: string[]): Promise<WeworkSendResult> {
    let cfg: any
    try {
      cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    } catch (err) {
      logger.error('wework: config lookup failed', { error: (err as Error).message })
      return { ok: false, reason: 'db_error' }
    }
    const conf = (cfg?.config as any) ?? {}
    if (!cfg || cfg.status !== 'ACTIVE' || !conf.weworkWebhookCipher) {
      return { ok: false, reason: 'not_configured' }
    }

    let webhook: string
    try {
      webhook = this.crypto.decrypt(conf.weworkWebhookCipher)
    } catch {
      return { ok: false, reason: 'cipher_error' }
    }

    // 企微 markdown 仅支持子集（不支持 # 标题语法），标题用加粗行代替
    const payload = {
      msgtype: 'markdown',
      markdown: { content: [`**${title}**`, '', ...lines].join('\n') },
    }

    let upstream: any
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timer)
      upstream = await res.json().catch(() => ({ errcode: -1, errmsg: `HTTP ${res.status}` }))
    } catch {
      return { ok: false, reason: 'network_error' }
    }
    if (upstream?.errcode === 0) return { ok: true }
    return { ok: false, reason: `upstream_${upstream?.errcode ?? 'unknown'}` }
  }

  /** 站点公网基址拼绝对 URL；未配置 APP_BASE_URL 返回 null（消息省略链接行） */
  private absoluteUrl(path: string): string | null {
    const base = config.app.baseUrl
    if (!base) return null
    return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
  }

  /** 审查终审通过通知 */
  async notifyReviewApproved(params: {
    tenantId: string
    contractId: string
    contractTitle: string
    stats: { total?: number; high?: number; med?: number; low?: number }
  }): Promise<WeworkSendResult> {
    const { tenantId, contractId, contractTitle, stats } = params
    const url = this.absoluteUrl(`/contracts/${contractId}`)
    const lines = [
      `合同：<font color="comment">${contractTitle}</font>`,
      `审查结论：人工终审已通过`,
      `共 ${stats.total ?? 0} 条风险：高 ${stats.high ?? 0} · 中 ${stats.med ?? 0} · 低 ${stats.low ?? 0}`,
      `完成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    ]
    if (url) lines.push(`[查看审查意见书](${url})`)
    const result = await this.sendMarkdown(tenantId, 'ClauseMind：合同审查终审通过', lines)
    if (!result.ok && result.reason !== 'not_configured') {
      logger.warn('wework: review-approved notify failed', { tenantId, reason: result.reason })
    }
    return result
  }

  /** 月度审查额度 80% / 100% 预警；Redis NX 按自然月去重 */
  async notifyQuota80(tenantId: string): Promise<WeworkSendResult> {
    const snapshot = await this.entitlements.getEntitlementSnapshot(tenantId)
    if (!snapshot || snapshot.monthlyReviewQuota === null) {
      return { ok: false, reason: 'below_threshold' }
    }
    const { usedReviews, monthlyReviewQuota } = snapshot
    if (usedReviews < monthlyReviewQuota || usedReviews / monthlyReviewQuota < 0.8) {
      return { ok: false, reason: 'below_threshold' }
    }

    const ym = new Date().toISOString().slice(0, 7)
    const key = `wework:quota80:${tenantId}:${ym}`
    const now = new Date()
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const ttlMs = monthEnd.getTime() - Date.now()
    const acquired = await this.redis.getClient().set(key, '1', 'PX', Math.max(ttlMs, 1000), 'NX')
    if (acquired !== 'OK') return { ok: false, reason: 'already_sent' }

    const url = this.absoluteUrl(snapshot.workspaceType === 'TEAM' ? '/billing' : '/me/billing')
    const exhausted = usedReviews >= monthlyReviewQuota
    const lines = [
      `当前用量：**${usedReviews}/${monthlyReviewQuota} 份**`,
      exhausted
        ? '升级套餐后订阅期不限份数，也可购买深度审查券 ¥9.9/份'
        : '额度即将用尽，升级套餐后订阅期不限份数',
    ]
    if (url) lines.push(`[查看套餐与升级](${url})`)
    const result = await this.sendMarkdown(
      tenantId,
      exhausted ? 'ClauseMind：本月审查额度已用尽' : 'ClauseMind：本月审查额度已用 80%',
      lines,
    )
    if (!result.ok && result.reason !== 'not_configured') {
      logger.warn('wework: quota80 notify failed', { tenantId, reason: result.reason })
    }
    return result
  }
}
