// server/src/integrations/integrations.service.ts
// 集成中心（FR：团队办公流集成）：
//   GET    /feishu        配置状态（Webhook 脱敏）
//   PUT    /feishu        保存群机器人 Webhook（AES-GCM 加密 + 域名白名单 SSRF 防护）
//   DELETE /feishu        移除配置
//   POST   /feishu/test   发送真实测试卡片
//   POST   /leads         其余 8 个「联系开通」留资
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { AuditService } from '../audit/audit.service.js'
import { IntegrationCryptoService } from './crypto.util.js'

/** 仅允许飞书官方域名（精确或其子域），防止 Webhook 被指向内网/任意外部地址 */
const ALLOWED_HOST_SUFFIXES = ['open.feishu.cn', 'feishu.cn', 'larksuite.com']

/** 「联系开通」的 8 个集成（飞书为已上线，FEISHU_SUPPORT 为飞书问题反馈留资） */
export const LEAD_INTEGRATIONS = [
  'FEISHU_SUPPORT',
  'DINGTALK', 'WECHAT_WORK', 'ESIGN', 'OA', 'SSO', 'OPEN_API', 'WORD_PLUGIN', 'PRIVATE_DEPLOY',
] as const

const PHONE_RE = /^[0-9+\-\s]{6,20}$/

@Injectable()
export class IntegrationsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly crypto: IntegrationCryptoService,
  ) {}

  private async assertAccess(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.entitlements.assertTeamSpace(tenant.plan)
    return tenant
  }

  /** 校验并规范化飞书机器人 Webhook（仅 https + 官方域名 + /hook/ 路径） */
  private parseFeishuWebhook(raw: string): string {
    const value = (raw ?? '').trim()
    if (!value) throw new BadRequestException('请填写 Webhook URL')
    let u: URL
    try {
      u = new URL(value)
    } catch {
      throw new BadRequestException('Webhook URL 格式不正确')
    }
    if (u.protocol !== 'https:') {
      throw new BadRequestException('仅支持 https 的飞书官方 Webhook')
    }
    const host = u.hostname.toLowerCase()
    const allowed = ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
    if (!allowed) {
      throw new BadRequestException('仅允许配置 open.feishu.cn / feishu.cn / larksuite.com 官方域名的 Webhook')
    }
    if (u.username || u.password) {
      throw new BadRequestException('Webhook URL 中不允许携带用户名密码')
    }
    if (!u.pathname.includes('/hook/')) {
      throw new BadRequestException('请填写飞书群机器人 Webhook（路径需包含 /hook/）')
    }
    return u.toString()
  }

  /** 脱敏展示：保留协议/域名/路径前缀，hook token 仅露末 4 位 */
  private maskWebhook(raw: string): string {
    const u = new URL(raw)
    const segments = u.pathname.split('/').filter(Boolean)
    const last = segments.pop() ?? ''
    if (last) segments.push(`****${last.slice(-4)}`)
    return `${u.protocol}//${u.host}/${segments.join('/')}`
  }

  // ── 飞书配置 ────────────────────────────────────────────────────────────

  async getFeishu(tenantId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    if (!cfg || cfg.status !== 'ACTIVE' || !(cfg.config as any)?.webhookCipher) {
      return { configured: false, webhookMask: null, lastTestAt: null, updatedAt: null }
    }
    let webhookMask = null
    try {
      webhookMask = this.maskWebhook(this.crypto.decrypt((cfg.config as any).webhookCipher))
    } catch {
      webhookMask = null
    }
    return { configured: true, webhookMask, lastTestAt: cfg.lastTestAt, updatedAt: cfg.updatedAt }
  }

  async saveFeishu(tenantId: string, userId: string, webhookUrl: string) {
    await this.assertAccess(tenantId)
    const url = this.parseFeishuWebhook(webhookUrl)
    const webhookCipher = this.crypto.encrypt(url)

    await this.db.integrationConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: 'FEISHU',
        status: 'ACTIVE',
        config: { webhookCipher },
      },
      update: {
        provider: 'FEISHU',
        status: 'ACTIVE',
        config: { webhookCipher },
      },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_FEISHU_SAVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'FEISHU', host: new URL(url).hostname },
    })

    return { configured: true, webhookMask: this.maskWebhook(url) }
  }

  async deleteFeishu(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    if (!cfg) throw new NotFoundException('尚未配置飞书集成')
    await this.db.integrationConfig.update({
      where: { tenantId },
      data: { status: 'NOT_CONFIGURED', config: {} },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_FEISHU_REMOVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'FEISHU' },
    })
    return { configured: false }
  }

  /** 发送真实飞书交互卡片（测试通知） */
  async sendTest(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    if (!cfg || cfg.status !== 'ACTIVE' || !(cfg.config as any)?.webhookCipher) {
      throw new BadRequestException('请先保存 Webhook URL')
    }

    let webhook: string
    try {
      webhook = this.crypto.decrypt((cfg.config as any).webhookCipher)
    } catch {
      throw new BadRequestException('凭证解析失败，请重新保存 Webhook URL')
    }

    const payload = {
      msg_type: 'interactive',
      card: {
        config: { wide_screen_mode: true },
        header: {
          template: 'blue',
          title: { tag: 'plain_text', content: 'WorkMind 测试通知' },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: [
                '**Webhook 连通测试成功**',
                '来自 WorkMind 集成中心：审查完成、合同到期 digest、额度 80% 预警将自动推送到本群。',
                `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
              ].join('\n'),
            },
          },
        ],
      },
    }

    let upstream: any
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timer)
      upstream = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }))
    } catch (err) {
      await this.audit.log({
        tenantId, userId,
        action: 'INTEGRATION_FEISHU_TEST',
        resource: 'integration_config',
        resourceId: tenantId,
        detail: { provider: 'FEISHU', success: false, error: 'network_error' },
      })
      throw new BadGatewayException('测试通知发送失败：无法连接飞书，请检查 Webhook 是否仍然有效')
    }

    const ok = upstream?.code === 0 || upstream?.StatusCode === 0
    await this.db.integrationConfig.update({
      where: { tenantId },
      data: { lastTestAt: new Date() },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_FEISHU_TEST',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'FEISHU', success: ok, upstreamCode: upstream?.code ?? upstream?.StatusCode ?? null },
    })

    if (!ok) {
      throw new BadGatewayException(`飞书返回错误：${upstream?.msg || 'unknown'}（code ${upstream?.code ?? upstream?.StatusCode}）`)
    }
    return { ok: true, upstream: { code: upstream.code ?? upstream.StatusCode, msg: upstream.msg ?? 'success' } }
  }

  // ── 联系开通留资 ────────────────────────────────────────────────────────

  async createLead(tenantId: string, userId: string, dto: {
    integration?: string; name?: string; phone?: string; note?: string
  }) {
    await this.assertAccess(tenantId)
    const integration = (dto.integration ?? '').trim()
    const name = (dto.name ?? '').trim()
    const phone = (dto.phone ?? '').trim()
    const note = (dto.note ?? '').trim()

    if (!LEAD_INTEGRATIONS.includes(integration as any)) {
      throw new BadRequestException('集成类型不合法')
    }
    if (!name || name.length > 100) throw new BadRequestException('请填写姓名（最多 100 字）')
    if (!PHONE_RE.test(phone)) throw new BadRequestException('请填写正确的联系电话')
    if (note.length > 500) throw new BadRequestException('需求备注最多 500 字')

    const lead = await this.db.integrationLead.create({
      data: { tenantId, userId, integration, name, phone, note: note || null },
      select: { id: true, integration: true, createdAt: true },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_LEAD_CREATE',
      resource: 'integration_lead',
      resourceId: lead.id,
      detail: { integration, name },
    })
    return { ok: true, id: lead.id }
  }
}
