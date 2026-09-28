// server/src/playbook/playbook.service.ts
// Playbook 企业审查规则（FR-17）：
//   租户红线/偏好规则 CRUD + 启停 + 命中统计；自然语言 AI 转结构化草稿（无 Key 409 手写兜底）；
//   样例条款本地正则/关键词试命中（不耗模型）；行业专项包一键复制为租户规则。
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import type { PlaybookKind, PlaybookRule, Severity } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'
import { AuditService } from '../audit/audit.service.js'
import { EntitlementsService } from '../billing/entitlements.service.js'
import { config as appConfig, isValidAiKey } from '../config/index.js'
import { createChatModel } from '../services/model.js'
import { tryRuleOnText } from '../contract/rules/rule.engine.js'
import { z } from 'zod'
import { getPack, INDUSTRY_PACKS } from './playbook.pack.js'

/** Playbook 结构化匹配规则（存 PlaybookRule.pattern JSON） */
export interface PlaybookPattern {
  keywords?: string[]
  regex?: string | null
  severity?: Severity
  suggestion?: string
}

const RULE_KINDS = ['FORBIDDEN', 'PREFERENCE'] as const
const TYPE_CODES = ['LABOR', 'LEASE', 'SERVICE', 'NDA', 'CUSTOM', 'ALL']
const SEVERITIES: Severity[] = ['HIGH', 'MED', 'LOW']

const PatternSchema = z.object({
  keywords: z.array(z.string().min(1).max(40)).max(20).optional(),
  regex: z.string().max(500).nullable().optional(),
  severity: z.enum(['HIGH', 'MED', 'LOW']).optional(),
  suggestion: z.string().max(500).optional(),
})

export interface RuleUpsertDto {
  title?: string
  description?: string | null
  naturalPrompt?: string
  kind?: PlaybookKind
  contractTypes?: string[]
  enabled?: boolean
  pattern?: PlaybookPattern
}

/** 校验正则可编译（线上引擎遇非法正则会静默降级关键词，配置期显式暴露） */
function assertRegex(regex?: string | null) {
  if (!regex) return
  try {
    new RegExp(regex, 'm')
  } catch (e) {
    throw new BadRequestException(`正则表达式不合法：${(e as Error).message}`)
  }
}

const HIT_WINDOW_DAYS = 30

@Injectable()
export class PlaybookService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Playbook 为团队空间能力：所有读写先过租户空间断言 */
  private async assertAccess(tenantId: string) {
    const tenant = await this.db.tenant.findUnique({ where: { id: tenantId } })
    if (!tenant) throw new NotFoundException('工作空间不存在')
    this.entitlements.assertTeamSpace(tenant.plan)
    return tenant
  }

  private serialize(r: PlaybookRule, hit30d: number) {
    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      description: r.description,
      naturalPrompt: r.naturalPrompt,
      pattern: (r.pattern as PlaybookPattern | null) ?? null,
      contractTypes: r.contractTypes,
      enabled: r.enabled,
      hitCount: r.hitCount,
      hit30d,
      source: r.source,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }

  /**
   * 近 30 天命中数：risk.ruleId 存 Playbook 规则 id、detectedBy=PLAYBOOK。
   * 与 hitCount 语义对齐——按审查任务去重（同一次审查多条款命中只计 1 次）。
   */
  private async countHits30d(ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map()
    const since = new Date(Date.now() - HIT_WINDOW_DAYS * 24 * 3600 * 1000)
    const groups = await this.db.risk.groupBy({
      by: ['ruleId', 'reviewTaskId'],
      where: { ruleId: { in: ids }, detectedBy: 'PLAYBOOK', createdAt: { gte: since } },
    })
    const map = new Map<string, Set<string>>()
    for (const g of groups) {
      if (!g.ruleId) continue
      const set = map.get(g.ruleId) ?? new Set<string>()
      set.add(g.reviewTaskId)
      map.set(g.ruleId, set)
    }
    return new Map([...map.entries()].map(([id, set]) => [id, set.size]))
  }

  async listRules(tenantId: string, kind?: string) {
    await this.assertAccess(tenantId)
    const where: any = { tenantId }
    if (kind && RULE_KINDS.includes(kind as any)) where.kind = kind
    const rules = await this.db.playbookRule.findMany({
      where,
      orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
    })
    const hits = await this.countHits30d(rules.map((r) => r.id))
    return { rules: rules.map((r) => this.serialize(r, hits.get(r.id) ?? 0)) }
  }

  private cleanDto(dto: RuleUpsertDto): {
    title?: string
    description?: string | null
    naturalPrompt?: string
    kind?: PlaybookKind
    contractTypes?: string[]
    enabled?: boolean
    pattern?: PlaybookPattern
  } {
    const out: any = {}
    if (dto.title !== undefined) {
      const title = String(dto.title).trim()
      if (!title) throw new BadRequestException('规则名称不能为空')
      if (title.length > 200) throw new BadRequestException('规则名称不超过 200 字')
      out.title = title
    }
    if (dto.description !== undefined) out.description = dto.description ? String(dto.description).slice(0, 2000) : null
    if (dto.naturalPrompt !== undefined) out.naturalPrompt = String(dto.naturalPrompt).slice(0, 2000)
    if (dto.kind !== undefined) {
      if (!RULE_KINDS.includes(dto.kind as any)) {
        throw new BadRequestException('规则类型仅支持红线规则 FORBIDDEN / 偏好口径 PREFERENCE')
      }
      out.kind = dto.kind
    }
    if (dto.contractTypes !== undefined) {
      if (!Array.isArray(dto.contractTypes)) throw new BadRequestException('适用类型必须是数组')
      const types = [...new Set(dto.contractTypes)]
      if (types.some((t) => !TYPE_CODES.includes(t))) throw new BadRequestException('存在不支持的合同类型编码')
      out.contractTypes = types
    }
    if (dto.enabled !== undefined) out.enabled = dto.enabled === true
    if (dto.pattern !== undefined) {
      const parsed = PatternSchema.safeParse(dto.pattern ?? {})
      if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? '结构化规则格式不合法')
      const pattern = parsed.data
      assertRegex(pattern.regex)
      if (!pattern.regex && !(pattern.keywords ?? []).filter(Boolean).length) {
        throw new BadRequestException('关键词与正则至少填写一项，否则规则无法命中')
      }
      out.pattern = pattern
    }
    return out
  }

  async createRule(tenantId: string, userId: string, dto: RuleUpsertDto) {
    await this.assertAccess(tenantId)
    const data = this.cleanDto(dto)
    if (!data.title) throw new BadRequestException('规则名称不能为空')
    if (!data.kind) data.kind = 'FORBIDDEN'
    if (!data.pattern) throw new BadRequestException('请先填写关键词/正则结构化规则')
    const rule = await this.db.playbookRule.create({
      data: {
        tenantId,
        createdById: userId,
        title: data.title,
        description: data.description ?? null,
        naturalPrompt: data.naturalPrompt ?? '',
        kind: data.kind,
        contractTypes: data.contractTypes ?? [],
        enabled: data.enabled ?? true,
        pattern: data.pattern as any,
        source: 'MANUAL',
      },
    })
    await this.audit.log({
      tenantId, userId, action: 'PLAYBOOK_RULE_CREATE', resource: 'playbook_rule', resourceId: rule.id,
      detail: { title: rule.title, kind: rule.kind },
    })
    return { rule: this.serialize(rule, 0) }
  }

  async updateRule(tenantId: string, userId: string, id: string, dto: RuleUpsertDto) {
    await this.assertAccess(tenantId)
    const existing = await this.db.playbookRule.findFirst({ where: { id, tenantId } })
    if (!existing) throw new NotFoundException('规则不存在')
    const data = this.cleanDto(dto)
    const rule = await this.db.playbookRule.update({ where: { id }, data: data as any })
    await this.audit.log({
      tenantId, userId, action: 'PLAYBOOK_RULE_UPDATE', resource: 'playbook_rule', resourceId: id,
      detail: { title: rule.title, enabled: rule.enabled },
    })
    const hits = await this.countHits30d([id])
    return { rule: this.serialize(rule, hits.get(id) ?? 0) }
  }

  async toggleRule(tenantId: string, userId: string, id: string, enabled: boolean) {
    await this.assertAccess(tenantId)
    const existing = await this.db.playbookRule.findFirst({ where: { id, tenantId } })
    if (!existing) throw new NotFoundException('规则不存在')
    const rule = await this.db.playbookRule.update({ where: { id }, data: { enabled } })
    await this.audit.log({
      tenantId, userId, action: 'PLAYBOOK_RULE_TOGGLE', resource: 'playbook_rule', resourceId: id,
      detail: { title: rule.title, enabled },
    })
    const hits = await this.countHits30d([id])
    return { rule: this.serialize(rule, hits.get(id) ?? 0) }
  }

  async deleteRule(tenantId: string, userId: string, id: string) {
    await this.assertAccess(tenantId)
    const existing = await this.db.playbookRule.findFirst({ where: { id, tenantId } })
    if (!existing) throw new NotFoundException('规则不存在')
    await this.db.playbookRule.delete({ where: { id } })
    await this.audit.log({
      tenantId, userId, action: 'PLAYBOOK_RULE_DELETE', resource: 'playbook_rule', resourceId: id,
      detail: { title: existing.title },
    })
    return { ok: true }
  }

  /**
   * 自然语言 → 结构化规则草稿（FR-17）。
   * 无 Key：409 Conflict，前端展开手写区，不阻塞配置。
   */
  async parseRule(naturalPrompt: string, contractTypes: string[] = []) {
    const prompt = String(naturalPrompt ?? '').trim()
    if (prompt.length < 4) throw new BadRequestException('请用一句话描述规则（至少 4 个字）')
    if (prompt.length > 1000) throw new BadRequestException('规则描述不超过 1000 字')
    if (!isValidAiKey(appConfig.ai.deepseekKey)) {
      throw new ConflictException('未配置模型 Key，请直接手写关键词与匹配条件，保存后照常生效')
    }

    const ParseSchema = z.object({
      keywords: z.array(z.string().min(1)).min(1).max(12)
        .describe('用于确定性匹配的中文关键词，全部出现才算命中；3~6 个为宜'),
      regex: z.string().max(500).describe('可选的 JavaScript 正则（不含两侧斜杠），无法可靠表达时返回空字符串'),
      severity: z.enum(['HIGH', 'MED', 'LOW']).describe('HIGH=红线/违法风险，MED=权利义务失衡，LOW=建议优化'),
      suggestion: z.string().max(500).describe('命中后给业务方的修改建议，一句话'),
    })
    const model = createChatModel({ temperature: 0.1, streaming: false })
    const structured = model.withStructuredOutput(ParseSchema, { name: 'playbook_rule_parse' })
    const out = await structured.invoke([
      ['human', `请把下面这条公司合同审查口径转成结构化匹配规则。
要求：关键词必须来自规则语义本身、尽量使用合同条款中会真实出现的中文原词；
正则可选，只在能显著降低误报时给出，不要给可能灾难性回溯的复杂正则；
适用类型提示：${contractTypes.join(',') || '通用'}。
规则：${prompt}`],
    ] as any)
    const pattern: PlaybookPattern = {
      keywords: (out.keywords ?? []).slice(0, 12),
      regex: out.regex || null,
      severity: SEVERITIES.includes(out.severity) ? out.severity : 'MED',
      suggestion: out.suggestion || '',
    }
    // AI 偶发产出非法正则：不报错，置空交给关键词
    if (pattern.regex) {
      try { new RegExp(pattern.regex, 'm') } catch { pattern.regex = null }
    }
    return { pattern, source: 'AI' as const }
  }

  /**
   * 样例条款试命中（本地执行，不耗模型）。
   * 逐行/逐段返回命中状态、模式与引用原文；正则非法显式返回 regexError。
   */
  testRule(patternInput: unknown, samples: unknown) {
    const parsed = PatternSchema.safeParse(patternInput ?? {})
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? '结构化规则格式不合法')
    const pattern = parsed.data
    if (!pattern.regex && !(pattern.keywords ?? []).length) {
      throw new BadRequestException('关键词与正则至少填写一项')
    }
    if (pattern.regex) {
      try { new RegExp(pattern.regex, 'gm') } catch (e) {
        return { results: [], regexError: (e as Error).message }
      }
    }
    const list = Array.isArray(samples)
      ? samples.map((s) => String(s)).filter((s) => s.trim())
      : String(samples ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
    if (!list.length) throw new BadRequestException('请提供至少一条样例条款')
    if (list.length > 10) throw new BadRequestException('一次最多测试 10 条样例')

    const results = list.slice(0, 10).map((text) => {
      const r = tryRuleOnText({ pattern: pattern.regex ?? null, keywords: pattern.keywords ?? [] }, text)
      return {
        sample: text.slice(0, 300),
        hit: r.hit,
        mode: r.mode,
        regexError: r.regexError,
        matches: r.matches.slice(0, 5).map((m) => m.quote),
      }
    })
    return { results, regexError: null }
  }

  /** 行业包列表 + 租户启用状态 */
  async listPacks(tenantId: string) {
    await this.assertAccess(tenantId)
    const seedRules = await this.db.playbookRule.findMany({
      where: { tenantId, source: 'SEED_PACK' },
      select: { title: true },
    })
    const owned = new Set(seedRules.map((r) => r.title))
    return {
      packs: INDUSTRY_PACKS.map((p) => ({
        code: p.code,
        name: p.name,
        team: p.team,
        ruleCount: p.ruleCount,
        desc: p.desc,
        features: p.features,
        live: p.live,
        enabled: p.live ? p.rules.every((r) => owned.has(r.title)) : false,
        ownedCount: p.live ? p.rules.filter((r) => owned.has(r.title)).length : 0,
      })),
    }
  }

  /** 一键启用：把行业包规则复制为租户规则（幂等，已存在的同标题规则跳过） */
  async enablePack(tenantId: string, userId: string, code: string) {
    await this.assertAccess(tenantId)
    const pack = getPack(code)
    if (!pack) throw new NotFoundException('行业包不存在')
    if (!pack.live) throw new BadRequestException('该行业包即将上线，敬请期待')

    const existing = await this.db.playbookRule.findMany({
      where: { tenantId, source: 'SEED_PACK' },
      select: { title: true },
    })
    const owned = new Set(existing.map((r) => r.title))
    const fresh = pack.rules.filter((r) => !owned.has(r.title))
    if (fresh.length) {
      await this.db.playbookRule.createMany({
        data: fresh.map((r) => ({
          tenantId,
          createdById: userId,
          kind: r.kind,
          title: r.title,
          description: r.description,
          naturalPrompt: r.naturalPrompt,
          contractTypes: r.contractTypes,
          pattern: r.pattern as any,
          enabled: true,
          source: 'SEED_PACK' as const,
        })),
      })
    }
    await this.audit.log({
      tenantId, userId, action: 'PLAYBOOK_PACK_ENABLE', resource: 'playbook_pack', resourceId: pack.code,
      detail: { pack: pack.name, copied: fresh.length, total: pack.rules.length },
    })
    return { ok: true, copied: fresh.length, skipped: pack.rules.length - fresh.length, total: pack.rules.length }
  }
}
