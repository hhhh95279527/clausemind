// server/src/services/feishu/feishu-notify.service.ts
// 飞书群机器人通知（FR-24 P0）：审查完成 / 额度 80% / 每日 digest 复用本服务。
// 所有失败均返回 {ok:false,reason}，绝不向业务链路抛异常——无配置是常态。
import { Injectable } from '@nestjs/common'
import { DatabaseService } from '../../database/database.service.js'
import { RedisService } from '../../redis/redis.service.js'
import { EntitlementsService } from '../../billing/entitlements.service.js'
import { IntegrationCryptoService } from '../../integrations/crypto.util.js'
import { config } from '../../config/index.js'
import { logger } from '../../utils/logger.js'

export interface SendCardResult {
  ok: boolean
  /** not_configured / cipher_error / network_error / upstream_<code> / db_error */
  reason?: string
}

interface CardAction {
  text: string
  url: string
  primary?: boolean
}

export interface InteractiveCardSpec {
  /** 卡片头配色（飞书模板色） */
  template: 'blue' | 'red' | 'green' | 'orange'
  title: string
  /** 正文 lark_md 行 */
  lines: string[]
  actions?: CardAction[]
}

const FETCH_TIMEOUT_MS = 8000

/** 构造飞书 webhook 交互卡片（v1 格式） */
export function buildInteractiveCard(spec: InteractiveCardSpec) {
  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: spec.lines.join('\n') },
    },
  ]
  if (spec.actions?.length) {
    elements.push({
      tag: 'hr',
    })
    elements.push({
      tag: 'action',
      actions: spec.actions.map((a) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: a.text },
        url: a.url,
        type: a.primary ? 'primary' : 'default',
      })),
    })
  }
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: spec.template,
        title: { tag: 'plain_text', content: spec.title },
      },
      elements,
    },
  }
}

@Injectable()
export class FeishuNotifyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly redis: RedisService,
    private readonly entitlements: EntitlementsService,
    private readonly crypto: IntegrationCryptoService,
  ) {}

  /** 向租户配置的飞书群发送卡片；未配置/失败均不抛异常 */
  async sendCard(tenantId: string, card: unknown): Promise<SendCardResult> {
    let cfg: any
    try {
      cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    } catch (err) {
      logger.error('feishu: config lookup failed', { error: (err as Error).message })
      return { ok: false, reason: 'db_error' }
    }
    if (!cfg || cfg.status !== 'ACTIVE' || !(cfg.config as any)?.webhookCipher) {
      return { ok: false, reason: 'not_configured' }
    }

    let webhook: string
    try {
      webhook = this.crypto.decrypt((cfg.config as any).webhookCipher)
    } catch {
      return { ok: false, reason: 'cipher_error' }
    }

    let upstream: any
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
        signal: controller.signal,
      })
      clearTimeout(timer)
      upstream = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }))
    } catch {
      return { ok: false, reason: 'network_error' }
    }
    if (upstream?.code === 0 || upstream?.StatusCode === 0) return { ok: true }
    return { ok: false, reason: `upstream_${upstream?.code ?? upstream?.StatusCode ?? 'unknown'}` }
  }

  /** 站点公网基址拼绝对 URL；未配置 APP_BASE_URL 返回 null（卡片省略按钮） */
  private absoluteUrl(path: string): string | null {
    const base = config.app.baseUrl
    if (!base) return null
    return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`
  }

  /** 审查终审通过通知（FR-24） */
  async notifyReviewApproved(params: {
    tenantId: string
    contractId: string
    contractTitle: string
    stats: { total?: number; high?: number; med?: number; low?: number }
  }): Promise<SendCardResult> {
    const { tenantId, contractId, contractTitle, stats } = params
    const url = this.absoluteUrl(`/contracts/${contractId}`)
    const card = buildInteractiveCard({
      template: (stats.high ?? 0) > 0 ? 'red' : (stats.med ?? 0) > 0 ? 'orange' : 'green',
      title: `合同审查终审通过：${contractTitle}`,
      lines: [
        `**审查结论：人工终审已通过**`,
        `共 ${stats.total ?? 0} 条风险：高 ${stats.high ?? 0} · 中 ${stats.med ?? 0} · 低 ${stats.low ?? 0}`,
        `完成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      ],
      actions: url ? [{ text: '查看审查意见书', url, primary: true }] : [],
    })
    const result = await this.sendCard(tenantId, card)
    if (!result.ok && result.reason !== 'not_configured') {
      logger.warn('feishu: review-approved notify failed', { tenantId, reason: result.reason })
    }
    return result
  }

  /** 月度审查额度 80% / 100% 预警；Redis NX 按自然月去重（FR-24） */
  async notifyQuota80(tenantId: string): Promise<SendCardResult> {
    const snapshot = await this.entitlements.getEntitlementSnapshot(tenantId)
    if (!snapshot || snapshot.monthlyReviewQuota === null) {
      return { ok: false, reason: 'below_threshold' }
    }
    const { usedReviews, monthlyReviewQuota } = snapshot
    if (usedReviews < monthlyReviewQuota || usedReviews / monthlyReviewQuota < 0.8) {
      return { ok: false, reason: 'below_threshold' }
    }

    const ym = new Date().toISOString().slice(0, 7)
    const key = `feishu:quota80:${tenantId}:${ym}`
    const now = new Date()
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const ttlMs = monthEnd.getTime() - Date.now()
    const acquired = await this.redis.getClient().set(key, '1', 'PX', Math.max(ttlMs, 1000), 'NX')
    if (acquired !== 'OK') return { ok: false, reason: 'already_sent' }

    const url = this.absoluteUrl(snapshot.workspaceType === 'TEAM' ? '/billing' : '/me/billing')
    const exhausted = usedReviews >= monthlyReviewQuota
    const card = buildInteractiveCard({
      template: exhausted ? 'red' : 'orange',
      title: exhausted ? '本月审查额度已用尽' : '本月审查额度已用 80%',
      lines: [
        `当前用量：**${usedReviews}/${monthlyReviewQuota} 份**`,
        exhausted
          ? '升级套餐后订阅期不限份数，也可购买深度审查券 ¥9.9/份'
          : '额度即将用尽，升级套餐后订阅期不限份数',
      ],
      actions: url ? [{ text: '查看套餐与升级', url, primary: true }] : [],
    })
    const result = await this.sendCard(tenantId, card)
    if (!result.ok && result.reason !== 'not_configured') {
      logger.warn('feishu: quota80 notify failed', { tenantId, reason: result.reason })
    }
    return result
  }
}
