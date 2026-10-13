// server/src/integrations/integrations.service.ts
// 集成中心（FR：团队办公流集成）：
//   GET    /feishu        配置状态（Webhook 脱敏）
//   PUT    /feishu        保存群机器人 Webhook（AES-GCM 加密 + 域名白名单 SSRF 防护）
//   DELETE /feishu        移除配置
//   POST   /feishu/test   发送真实测试卡片
//   POST   /leads         其余 8 个「联系开通」留资
import { createHmac } from 'node:crypto'
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

/** 钉钉群机器人官方域名（精确匹配） */
const DINGTALK_HOST = 'oapi.dingtalk.com'

/** 「联系开通」的集成（飞书/钉钉已上线，FEISHU_SUPPORT 为飞书问题反馈留资） */
const LEAD_INTEGRATIONS = [
  'FEISHU_SUPPORT',
  'WECHAT_WORK', 'ESIGN', 'OA', 'SSO', 'OPEN_API', 'WORD_PLUGIN', 'PRIVATE_DEPLOY',
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

  /** 三家 Webhook 公共校验：非空/可解析/https/禁带账号密码；厂商专属域名与路径由调用方继续校验 */
  private parseWebhookBase(raw: string, vendor: string): URL {
    const value = (raw ?? '').trim()
    if (!value) throw new BadRequestException('请填写 Webhook URL')
    let u: URL
    try {
      u = new URL(value)
    } catch {
      throw new BadRequestException('Webhook URL 格式不正确')
    }
    if (u.protocol !== 'https:') {
      throw new BadRequestException(`仅支持 https 的${vendor}官方 Webhook`)
    }
    if (u.username || u.password) {
      throw new BadRequestException('Webhook URL 中不允许携带用户名密码')
    }
    return u
  }

  /** 8s 超时的 JSON POST（三家测试通知共用；响应体解析与错误口径由调用方处理） */
  private async postWebhook(url: string, payload: unknown) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 测试发送后回写最后测试时间（三家一致） */
  private touchLastTest(tenantId: string) {
    return this.db.integrationConfig.update({
      where: { tenantId },
      data: { lastTestAt: new Date() },
    })
  }

  /** query-token 型 Webhook（钉钉 access_token / 企微 key）的统一脱敏：token 仅露末 4 位 */
  private maskTokenWebhook(raw: string, param: string): string {
    const u = new URL(raw)
    const token = u.searchParams.get(param) ?? ''
    return `${u.protocol}//${u.host}${u.pathname}?${param}=****${token.slice(-4)}`
  }

  /** 校验并规范化飞书机器人 Webhook（仅 https + 官方域名 + /hook/ 路径） */
  private parseFeishuWebhook(raw: string): string {
    const u = this.parseWebhookBase(raw, '飞书')
    const host = u.hostname.toLowerCase()
    const allowed = ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))
    if (!allowed) {
      throw new BadRequestException('仅允许配置 open.feishu.cn / feishu.cn / larksuite.com 官方域名的 Webhook')
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

    // 与钉钉配置共存于同一行的 config jsonb：合并而非覆盖
    const existing = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const merged = { ...((existing?.config as any) ?? {}), webhookCipher }
    await this.db.integrationConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        provider: 'FEISHU',
        status: 'ACTIVE',
        config: merged,
      },
      update: {
        status: 'ACTIVE',
        config: merged,
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
    if (!cfg || !(cfg.config as any)?.webhookCipher) throw new NotFoundException('尚未配置飞书集成')
    // 只移除飞书子键，保留钉钉配置；两者都空时状态才回到 NOT_CONFIGURED
    const rest = { ...(cfg.config as any) }
    delete rest.webhookCipher
    const hasOthers = !!rest.dingtalkWebhookCipher || !!rest.weworkWebhookCipher
    await this.db.integrationConfig.update({
      where: { tenantId },
      data: { status: hasOthers ? 'ACTIVE' : 'NOT_CONFIGURED', config: rest },
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
          title: { tag: 'plain_text', content: 'ClauseMind 测试通知' },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: [
                '**Webhook 连通测试成功**',
                '来自 ClauseMind 集成中心：审查完成、合同到期 digest、额度 80% 预警将自动推送到本群。',
                `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
              ].join('\n'),
            },
          },
        ],
      },
    }

    let upstream: any
    try {
      const res = await this.postWebhook(webhook, payload)
      upstream = await res.json().catch(() => ({ code: -1, msg: `HTTP ${res.status}` }))
    } catch {
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
    await this.touchLastTest(tenantId)
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

  // ── 钉钉配置 ────────────────────────────────────────────────────────────

  /** 校验并规范化钉钉机器人 Webhook（https + oapi.dingtalk.com + /robot/send + access_token） */
  private parseDingtalkWebhook(raw: string): string {
    const u = this.parseWebhookBase(raw, '钉钉')
    if (u.hostname.toLowerCase() !== DINGTALK_HOST) {
      throw new BadRequestException('仅允许配置 oapi.dingtalk.com 官方域名的 Webhook')
    }
    if (!u.pathname.startsWith('/robot/send')) {
      throw new BadRequestException('请填写钉钉群机器人 Webhook（路径为 /robot/send）')
    }
    const token = u.searchParams.get('access_token') ?? ''
    if (token.length < 10) {
      throw new BadRequestException('Webhook 缺少有效的 access_token 参数')
    }
    // 丢弃多余 query，仅保留 access_token（签名参数由发送时计算）
    return `https://${DINGTALK_HOST}/robot/send?access_token=${encodeURIComponent(token)}`
  }

  private assertDingtalkSecret(raw: string): string | null {
    const value = (raw ?? '').trim()
    if (!value) return null
    if (value.length > 128) throw new BadRequestException('加签密钥最长 128 字符')
    return value
  }

  async getDingtalk(tenantId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const conf = (cfg?.config as any) ?? {}
    if (!cfg || cfg.status !== 'ACTIVE' || !conf.dingtalkWebhookCipher) {
      return { configured: false, webhookMask: null, hasSecret: false, lastTestAt: null, updatedAt: null }
    }
    let webhookMask = null
    try {
      webhookMask = this.maskTokenWebhook(this.crypto.decrypt(conf.dingtalkWebhookCipher), 'access_token')
    } catch {
      webhookMask = null
    }
    return {
      configured: true,
      webhookMask,
      hasSecret: !!conf.dingtalkSecretCipher,
      lastTestAt: cfg.lastTestAt,
      updatedAt: cfg.updatedAt,
    }
  }

  async saveDingtalk(tenantId: string, userId: string, webhookUrl: string, secret?: string) {
    await this.assertAccess(tenantId)
    const url = this.parseDingtalkWebhook(webhookUrl)
    const signSecret = this.assertDingtalkSecret(secret ?? '')
    const dingtalkWebhookCipher = this.crypto.encrypt(url)

    const existing = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const merged: any = { ...((existing?.config as any) ?? {}), dingtalkWebhookCipher }
    // 空 secret 视为清除加签；非空则加密覆盖
    if (signSecret) merged.dingtalkSecretCipher = this.crypto.encrypt(signSecret)
    else delete merged.dingtalkSecretCipher

    await this.db.integrationConfig.upsert({
      where: { tenantId },
      create: { tenantId, provider: 'FEISHU', status: 'ACTIVE', config: merged },
      update: { status: 'ACTIVE', config: merged },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_DINGTALK_SAVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'DINGTALK', host: DINGTALK_HOST, hasSecret: !!signSecret },
    })

    return { configured: true, webhookMask: this.maskTokenWebhook(url, 'access_token'), hasSecret: !!signSecret }
  }

  async deleteDingtalk(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    if (!cfg || !(cfg.config as any)?.dingtalkWebhookCipher) throw new NotFoundException('尚未配置钉钉集成')
    const rest = { ...(cfg.config as any) }
    delete rest.dingtalkWebhookCipher
    delete rest.dingtalkSecretCipher
    const hasOthers = !!rest.webhookCipher || !!rest.weworkWebhookCipher
    await this.db.integrationConfig.update({
      where: { tenantId },
      data: { status: hasOthers ? 'ACTIVE' : 'NOT_CONFIGURED', config: rest },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_DINGTALK_REMOVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'DINGTALK' },
    })
    return { configured: false }
  }

  /** 发送真实钉钉 markdown 消息（测试通知；含加签支持） */
  async sendDingtalkTest(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const conf = (cfg?.config as any) ?? {}
    if (!cfg || cfg.status !== 'ACTIVE' || !conf.dingtalkWebhookCipher) {
      throw new BadRequestException('请先保存 Webhook URL')
    }

    let webhook: string
    let secret: string | null = null
    try {
      webhook = this.crypto.decrypt(conf.dingtalkWebhookCipher)
      if (conf.dingtalkSecretCipher) secret = this.crypto.decrypt(conf.dingtalkSecretCipher)
    } catch {
      throw new BadRequestException('凭证解析失败，请重新保存 Webhook URL')
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: 'ClauseMind 测试通知',
        text: [
          '## ClauseMind 测试通知',
          '',
          '**Webhook 连通测试成功**',
          '',
          '来自 ClauseMind 集成中心：审查完成、额度 80% 预警将自动推送到本群。',
          '',
          `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        ].join('\n'),
      },
    }

    let url = webhook
    if (secret) {
      const timestamp = Date.now()
      const sign = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64')
      url += `&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }

    let upstream: any
    try {
      const res = await this.postWebhook(url, payload)
      upstream = await res.json().catch(() => ({ errcode: -1, errmsg: `HTTP ${res.status}` }))
    } catch {
      await this.audit.log({
        tenantId, userId,
        action: 'INTEGRATION_DINGTALK_TEST',
        resource: 'integration_config',
        resourceId: tenantId,
        detail: { provider: 'DINGTALK', success: false, error: 'network_error' },
      })
      throw new BadGatewayException('测试通知发送失败：无法连接钉钉，请检查 Webhook 是否仍然有效')
    }

    const ok = upstream?.errcode === 0
    await this.touchLastTest(tenantId)
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_DINGTALK_TEST',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'DINGTALK', success: ok, upstreamCode: upstream?.errcode ?? null },
    })

    if (!ok) {
      throw new BadGatewayException(`钉钉返回错误：${upstream?.errmsg || 'unknown'}（errcode ${upstream?.errcode}）`)
    }
    return { ok: true, upstream: { errcode: 0, errmsg: upstream.errmsg ?? 'ok' } }
  }

  // ── 企业微信配置 ─────────────────────────────────────────────────────────

  /** 校验并规范化企微机器人 Webhook（https + qyapi.weixin.qq.com + key 参数） */
  private parseWeworkWebhook(raw: string): string {
    const u = this.parseWebhookBase(raw, '企业微信')
    if (u.hostname.toLowerCase() !== 'qyapi.weixin.qq.com') {
      throw new BadRequestException('仅允许配置 qyapi.weixin.qq.com 官方域名的 Webhook')
    }
    if (!u.pathname.startsWith('/cgi-bin/webhook/send')) {
      throw new BadRequestException('请填写企业微信群机器人 Webhook（路径为 /cgi-bin/webhook/send）')
    }
    const key = u.searchParams.get('key') ?? ''
    if (key.length < 10) {
      throw new BadRequestException('Webhook 缺少有效的 key 参数')
    }
    return `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`
  }

  async getWework(tenantId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const conf = (cfg?.config as any) ?? {}
    if (!cfg || cfg.status !== 'ACTIVE' || !conf.weworkWebhookCipher) {
      return { configured: false, webhookMask: null, lastTestAt: null, updatedAt: null }
    }
    let webhookMask = null
    try {
      webhookMask = this.maskTokenWebhook(this.crypto.decrypt(conf.weworkWebhookCipher), 'key')
    } catch {
      webhookMask = null
    }
    return { configured: true, webhookMask, lastTestAt: cfg.lastTestAt, updatedAt: cfg.updatedAt }
  }

  async saveWework(tenantId: string, userId: string, webhookUrl: string) {
    await this.assertAccess(tenantId)
    const url = this.parseWeworkWebhook(webhookUrl)
    const weworkWebhookCipher = this.crypto.encrypt(url)

    const existing = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const merged: any = { ...((existing?.config as any) ?? {}), weworkWebhookCipher }
    await this.db.integrationConfig.upsert({
      where: { tenantId },
      create: { tenantId, provider: 'FEISHU', status: 'ACTIVE', config: merged },
      update: { status: 'ACTIVE', config: merged },
    })

    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_WEWORK_SAVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'WEWORK', host: 'qyapi.weixin.qq.com' },
    })

    return { configured: true, webhookMask: this.maskTokenWebhook(url, 'key') }
  }

  async deleteWework(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    if (!cfg || !(cfg.config as any)?.weworkWebhookCipher) throw new NotFoundException('尚未配置企业微信集成')
    const rest = { ...(cfg.config as any) }
    delete rest.weworkWebhookCipher
    const hasOthers = !!rest.webhookCipher || !!rest.dingtalkWebhookCipher
    await this.db.integrationConfig.update({
      where: { tenantId },
      data: { status: hasOthers ? 'ACTIVE' : 'NOT_CONFIGURED', config: rest },
    })
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_WEWORK_REMOVE',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'WEWORK' },
    })
    return { configured: false }
  }

  /** 发送真实企微 markdown 消息（测试通知） */
  async sendWeworkTest(tenantId: string, userId: string) {
    await this.assertAccess(tenantId)
    const cfg = await this.db.integrationConfig.findUnique({ where: { tenantId } })
    const conf = (cfg?.config as any) ?? {}
    if (!cfg || cfg.status !== 'ACTIVE' || !conf.weworkWebhookCipher) {
      throw new BadRequestException('请先保存 Webhook URL')
    }

    let webhook: string
    try {
      webhook = this.crypto.decrypt(conf.weworkWebhookCipher)
    } catch {
      throw new BadRequestException('凭证解析失败，请重新保存 Webhook URL')
    }

    const payload = {
      msgtype: 'markdown',
      markdown: {
        content: [
          '**ClauseMind 测试通知**',
          '',
          '**Webhook 连通测试成功**',
          '',
          '来自 ClauseMind 集成中心：审查完成、合同到期 digest、额度 80% 预警将自动推送到本群。',
          '',
          `发送时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        ].join('\n'),
      },
    }

    let upstream: any
    try {
      const res = await this.postWebhook(webhook, payload)
      upstream = await res.json().catch(() => ({ errcode: -1, errmsg: `HTTP ${res.status}` }))
    } catch {
      await this.audit.log({
        tenantId, userId,
        action: 'INTEGRATION_WEWORK_TEST',
        resource: 'integration_config',
        resourceId: tenantId,
        detail: { provider: 'WEWORK', success: false, error: 'network_error' },
      })
      throw new BadGatewayException('测试通知发送失败：无法连接企业微信，请检查 Webhook 是否仍然有效')
    }

    const ok = upstream?.errcode === 0
    await this.touchLastTest(tenantId)
    await this.audit.log({
      tenantId, userId,
      action: 'INTEGRATION_WEWORK_TEST',
      resource: 'integration_config',
      resourceId: tenantId,
      detail: { provider: 'WEWORK', success: ok, upstreamCode: upstream?.errcode ?? null },
    })

    if (!ok) {
      throw new BadGatewayException(`企业微信返回错误：${upstream?.errmsg || 'unknown'}（errcode ${upstream?.errcode}）`)
    }
    return { ok: true, upstream: { errcode: 0, errmsg: upstream.errmsg ?? 'ok' } }
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
