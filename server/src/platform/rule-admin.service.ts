// server/src/platform/rule-admin.service.ts
// 全局审查规则管理：review_rules CRUD（平台级配置，对所有租户生效）+ 规则试运行（不落库）。
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma, Severity } from '@prisma/client'
import { DatabaseService } from '../database/database.service.js'
import { tryRuleOnText } from '../contract/rules/rule.engine.js'
import { logger } from '../utils/logger.js'

const SEVERITIES: readonly Severity[] = ['HIGH', 'MED', 'LOW']
const SCOPES = ['ALL', 'LABOR', 'INTERNSHIP'] as const
const MAX_TRY_TEXT = 20_000

export interface RuleInput {
  code?: string
  name?: string
  severity?: string
  category?: string
  scope?: string
  pattern?: string | null
  keywords?: string[]
  prompt?: string
  suggestion?: string | null
  legalBasis?: string | null
  description?: string | null
  enabled?: boolean
  sortOrder?: number
}

export interface RuleListQuery {
  q?: string
  scope?: string
  enabled?: string
  page?: number
  pageSize?: number
}

@Injectable()
export class RuleAdminService {
  constructor(private db: DatabaseService) {}

  list(q: RuleListQuery) {
    const page = Math.max(1, Number(q.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 20))
    const where: any = {}
    if (q.scope === 'ALL' || q.scope === 'LABOR') where.scope = q.scope
    if (q.enabled === 'true') where.enabled = true
    if (q.enabled === 'false') where.enabled = false
    if (q.q?.trim()) {
      const term = q.q.trim()
      where.OR = [
        { code: { contains: term, mode: 'insensitive' } },
        { name: { contains: term, mode: 'insensitive' } },
        { category: { contains: term, mode: 'insensitive' } },
      ]
    }

    return Promise.all([
      this.db.reviewRule.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.reviewRule.count({ where }),
    ]).then(([rules, total]) => ({ rules, total, page, pageSize }))
  }

  async get(id: string) {
    const rule = await this.db.reviewRule.findUnique({ where: { id } })
    if (!rule) throw new NotFoundException('规则不存在')
    return rule
  }

  async create(input: RuleInput) {
    const data = this.validate(input, true)
    await this.assertCodeUnique(data.code as string)
    return this.db.reviewRule.create({ data: data as Prisma.ReviewRuleUncheckedCreateInput })
  }

  async update(id: string, input: RuleInput) {
    await this.get(id)
    const data = this.validate(input, false)
    if (data.code) await this.assertCodeUnique(data.code as string, id)
    return this.db.reviewRule.update({ where: { id }, data: data as Prisma.ReviewRuleUncheckedUpdateInput })
  }

  private async assertCodeUnique(code: string, exceptId?: string) {
    const existing = await this.db.reviewRule.findUnique({ where: { code } })
    if (existing && existing.id !== exceptId) {
      throw new BadRequestException(`规则编码 ${code} 已存在`)
    }
  }

  async remove(id: string) {
    await this.get(id)
    // 历史 Risk 已快照 title/quote/analysis，ruleId 为无外键松散引用，硬删不影响已出报告
    await this.db.reviewRule.delete({ where: { id } })
    logger.info('admin: review rule deleted', { id })
    return { success: true }
  }

  /**
   * 试运行：id 给已存规则（字段覆盖），或直接给完整 rule 字段（编辑中未落库）。
   * 不落库、不写任何业务数据。
   */
  async tryRule(body: { id?: string; rule?: RuleInput; text?: string; labor?: boolean; internship?: boolean }) {
    const text = (body.text ?? '').toString()
    if (!text.trim()) throw new BadRequestException('请粘贴待检测的条款文本')
    if (text.length > MAX_TRY_TEXT) throw new BadRequestException(`试运行文本不超过 ${MAX_TRY_TEXT} 字`)

    let base: any = null
    if (body.id) {
      base = await this.db.reviewRule.findUnique({ where: { id: body.id } })
      if (!base) throw new NotFoundException('规则不存在')
    }
    const merged = { ...(base ?? {}), ...(body.rule ?? {}) }
    const rule = {
      pattern: merged.pattern ? String(merged.pattern) : null,
      keywords: Array.isArray(merged.keywords)
        ? merged.keywords.map((k: unknown) => String(k).trim()).filter(Boolean)
        : [],
    }

    const scope = String(merged.scope ?? 'ALL')
    const skipped = (scope === 'LABOR' && !body.labor)
      || (scope === 'INTERNSHIP' && !body.internship)
    const result = skipped
      ? { hit: false, mode: null, regexError: null, matches: [] }
      : tryRuleOnText(rule, text)

    return {
      code: merged.code ?? '(未保存规则)',
      name: merged.name ?? '',
      scope,
      labor: !!body.labor,
      internship: !!body.internship,
      skipped,
      ...result,
      matchCount: result.matches.length,
    }
  }

  // ── 校验与归一化 ────────────────────────────────────────────────
  private validate(input: RuleInput, requireAll: boolean) {
    const out: Record<string, any> = {}

    if (input.code !== undefined || requireAll) {
      const code = (input.code ?? '').toString().trim().toUpperCase()
      if (!code) throw new BadRequestException('规则编码不能为空')
      if (code.length > 50) throw new BadRequestException('规则编码不超过 50 字符')
      if (!/^[A-Z][A-Z0-9_-]*$/.test(code)) {
        throw new BadRequestException('规则编码须以大写字母开头，仅含大写字母/数字/-/_')
      }
      out.code = code
    }

    if (input.name !== undefined || requireAll) {
      const name = (input.name ?? '').toString().trim()
      if (!name) throw new BadRequestException('规则名称不能为空')
      if (name.length > 200) throw new BadRequestException('规则名称不超过 200 字符')
      out.name = name
    }

    if (input.severity !== undefined || requireAll) {
      const severity = (input.severity ?? 'MED').toString().trim().toUpperCase()
      if (!SEVERITIES.includes(severity as Severity)) {
        throw new BadRequestException('severity 只能是 HIGH/MED/LOW')
      }
      out.severity = severity
    }

    if (input.category !== undefined || requireAll) {
      const category = (input.category ?? '').toString().trim()
      if (!category) throw new BadRequestException('风险分类不能为空')
      if (category.length > 50) throw new BadRequestException('风险分类不超过 50 字符')
      out.category = category
    }

    if (input.scope !== undefined) {
      const scope = input.scope.toString().trim().toUpperCase()
      if (!SCOPES.includes(scope as any)) throw new BadRequestException('scope 只能是 ALL/LABOR/INTERNSHIP')
      out.scope = scope
    }

    if (input.pattern !== undefined) {
      const pattern = input.pattern?.toString().trim() || null
      if (pattern) {
        try {
          new RegExp(pattern, 'm')
        } catch (e) {
          throw new BadRequestException(`正则表达式非法：${(e as Error).message}`)
        }
      }
      out.pattern = pattern
    }

    if (input.keywords !== undefined) {
      if (!Array.isArray(input.keywords)) throw new BadRequestException('keywords 必须是数组')
      out.keywords = input.keywords.map((k) => k.toString().trim()).filter(Boolean).slice(0, 20)
    }

    if (input.prompt !== undefined || requireAll) {
      const prompt = (input.prompt ?? '').toString().trim()
      if (!prompt) throw new BadRequestException('语义判定描述(prompt)不能为空（AI 轨依赖）')
      out.prompt = prompt
    }

    for (const f of ['suggestion', 'legalBasis', 'description'] as const) {
      if (input[f] !== undefined) {
        const v = input[f]?.toString().trim()
        out[f] = v || null
      }
    }

    if (input.enabled !== undefined) out.enabled = !!input.enabled

    if (input.sortOrder !== undefined) {
      const n = Number(input.sortOrder)
      if (!Number.isFinite(n)) throw new BadRequestException('sortOrder 必须是数字')
      out.sortOrder = Math.trunc(n)
    }

    return out
  }
}
